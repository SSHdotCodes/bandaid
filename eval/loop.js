#!/usr/bin/env node
'use strict';

/**
 * Measure the loop, not the grader.
 *
 * `eval/run.js` measures the judge: one verdict, single-shot, over a fresh
 * repository that already contains the ground truth. It is a good harness for what
 * it measures and it cannot measure anything that lives in the continuation prompt,
 * because the judge never sees the continuation prompt. Its own comment says so and
 * excludes the 277-word completion audit from `ABLATABLE` for exactly that reason.
 *
 * This runs the Stop loop instead: several rounds against a fixture repository that
 * **changes between them**. That also happens to be, precisely, the fixture
 * karpathy-report.md says the evidence ledger needs to be kept or killed — two
 * sequential judgements over a moving repository — so one harness settles three
 * open items.
 *
 *   node eval/loop.js
 *   node eval/loop.js --filter converging
 *   node eval/loop.js --rounds 8
 *   node eval/loop.js --ablate completion-audit    withhold a prompt block
 *   node eval/loop.js --ablate ledger              withhold the accumulated evidence
 *   node eval/loop.js --ablate seal                withhold the held-out check
 *   node eval/loop.js --judge                      let judged fixtures run the judge
 *   node eval/loop.js --worker claude              a model reads the prompt (brief 13)
 *   node eval/loop.js --worker claude --samples 5  and reads it five times
 *   node eval/loop.js --json
 *
 * The default run is offline, deterministic and about 17 seconds. `--judge` costs a
 * subprocess and 12–16s per stop and needs `claude` on PATH, so it is opt-in twice:
 * the fixture declares `"judge": true` and the run passes the flag.
 *
 * ## Two workers, and what each one may be quoted for
 *
 * The default worker is a **script**. Each fixture ships a sequence of mutations that
 * stands in for what a model would do, which makes the harness deterministic, free,
 * and reviewable — and means it measures the loop's *mechanics*: when it blocks, when
 * it releases, what ends it. A prose block that only changes what a model chooses to
 * do is invisible to it, because a script does not read the prompt.
 *
 * So `--ablate completion-audit` on the scripted tier answers "does withholding the
 * audit change the loop's decisions, given a fixed worker" — a real question with a
 * real answer, and a strictly weaker claim than "the audit makes models more honest".
 * Nothing from that tier may be quoted as the latter.
 *
 * `--worker claude` is the tier that can be. It hands the model the objective on
 * round 1 and the previous stop's continuation prompt — verbatim — on every round
 * after, so withholding a block genuinely changes what was read. Opt-in twice like
 * the judge (`"worker": true` in the fixture, plus the flag), it costs real money and
 * it is nondeterministic, which is what `--samples` is for. One run of it is an
 * anecdote; docs/plans/13-model-worker.md states what may be claimed from it.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'loop-fixtures');
const STOP = path.join(ROOT, 'src', 'hooks', 'stop.js');
const CLI = path.join(ROOT, 'bin', 'bandaid.js');

const DEFAULT_MAX_ROUNDS = 6;

/** One run of a nondeterministic worker is an anecdote. Five is a rate. */
const DEFAULT_MODEL_SAMPLES = 5;

/**
 * Per-round wall clock for the model worker, generous on purpose.
 *
 * A worker killed mid-edit produces a round that changed nothing, which is
 * indistinguishable in the results from a model that chose not to act — and that is
 * the one confound capable of corrupting both arms of an ablation without saying so.
 * Better to wait than to record a timeout as a decision.
 */
const DEFAULT_WORKER_TIMEOUT_MS = 300_000;

/**
 * Mechanisms withheld by not configuring them, rather than by BANDAID_ABLATE.
 * Neither is a prompt block, so naming them to the prompt ablator would do
 * nothing at all and report a clean result for a run that changed nothing.
 */
const ABLATED_BY_ABSENCE = new Set(['ledger', 'seal']);

function parseArgs(argv) {
  const flags = {
    filter: null,
    rounds: DEFAULT_MAX_ROUNDS,
    ablate: null,
    json: false,
    judge: false,
    worker: null,
    workerModel: 'haiku',
    workerTimeoutMs: DEFAULT_WORKER_TIMEOUT_MS,
    samples: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') flags.json = true;
    else if (argv[i] === '--judge') flags.judge = true;
    else if (argv[i] === '--filter') flags.filter = argv[i + 1];
    else if (argv[i] === '--rounds') flags.rounds = Number(argv[i + 1]) || DEFAULT_MAX_ROUNDS;
    else if (argv[i] === '--ablate') flags.ablate = argv[i + 1];
    else if (argv[i] === '--worker') flags.worker = argv[i + 1];
    else if (argv[i] === '--worker-model') flags.workerModel = argv[i + 1];
    else if (argv[i] === '--worker-timeout') {
      flags.workerTimeoutMs = (Number(argv[i + 1]) || DEFAULT_WORKER_TIMEOUT_MS / 1000) * 1000;
    } else if (argv[i] === '--samples') flags.samples = Number(argv[i + 1]) || 1;
  }
  // Sampling only means something against a worker that can disagree with itself. The
  // scripted tier is deterministic, so its default stays exactly one pass — which is
  // what keeps `npm run loop` at ~17s and its --json shape byte-identical to before.
  if (flags.samples == null) flags.samples = flags.worker ? DEFAULT_MODEL_SAMPLES : 1;
  return flags;
}

/** A fixture is model-driven only if the run asked for it *and* the fixture opted in. */
function modelDriven(fixture, flags) {
  return flags.worker === 'claude' && fixture.expected.worker === true;
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

function loadFixture(dir) {
  const base = path.join(FIXTURES, dir);
  const objective = readIfPresent(path.join(base, 'objective.txt'));
  if (!objective) return null;

  const criteria = (readIfPresent(path.join(base, 'criteria.txt')) || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const roundsDir = path.join(base, 'rounds');
  let rounds = [];
  try {
    rounds = fs.readdirSync(roundsDir).filter((f) => f.endsWith('.sh')).sort();
  } catch {
    rounds = [];
  }

  return {
    name: dir,
    objective,
    criteria,
    check: readIfPresent(path.join(base, 'check.sh')),
    seal: readIfPresent(path.join(base, 'seal.sh')),
    expected: JSON.parse(readIfPresent(path.join(base, 'expected.json')) || '{}'),
    repo: path.join(base, 'repo'),
    roundsDir,
    rounds,
  };
}

/** One throwaway repo and one throwaway state dir, both removed afterwards. */
function sandbox(fixture) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `bandaid-loop-${fixture.name}-`));
  fs.cpSync(fixture.repo, repo, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-loop-home-'));

  // A real commit, so baseSha and changedPaths behave as they do in a live session.
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'loop@example.com');
  git('config', 'user.name', 'loop');
  git('add', '-A');
  git('commit', '-qm', 'fixture');

  if (fixture.check) {
    fs.writeFileSync(path.join(repo, 'check.sh'), `${fixture.check}\n`);
    fs.chmodSync(path.join(repo, 'check.sh'), 0o755);
  }

  if (fixture.seal) {
    fs.writeFileSync(path.join(repo, 'seal.sh'), `${fixture.seal}\n`);
    fs.chmodSync(path.join(repo, 'seal.sh'), 0o755);
  }

  return { repo, home };
}

const SESSION = 'loop';

function env(home, extra = {}) {
  return { ...process.env, BANDAID_HOME: home, CLAUDE_SESSION_ID: SESSION, ...extra };
}

function cli(args, home, cwd) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: env(home), cwd });
}

/**
 * Withhold the accumulated evidence ledger from this round.
 *
 * `eval/run.js` ablates the ledger by simply not seeding it. The loop equivalent is
 * to clear it before each stop, so the judge grades from the repository alone with
 * no memory of what earlier rounds established — which is the question
 * karpathy-report.md says needs "two sequential judgements over a repository that
 * changes between them".
 */
function clearLedger(home) {
  const projects = path.join(home, 'projects');
  let keys;
  try {
    keys = fs.readdirSync(projects);
  } catch {
    return;
  }
  for (const key of keys) {
    try {
      fs.rmSync(path.join(projects, key, 'evidence.jsonl'), { force: true });
    } catch {
      // Nothing to withhold is not a failure.
    }
  }
}

/** Run the real Stop hook the way Claude Code runs it: JSON in, meaning in the code. */
function runStop({ home, repo, extraEnv }) {
  const input = JSON.stringify({ session_id: SESSION, cwd: repo, stop_hook_active: false });
  const result = { code: 0, stderr: '' };
  try {
    // stdio must be 'pipe' explicitly: execFileSync forwards the child's stderr to
    // the parent's by default, and the continuation prompt is on stderr — so
    // without this the harness prints every prompt it captures.
    execFileSync(process.execPath, [STOP], {
      input,
      encoding: 'utf8',
      env: env(home, extraEnv),
      cwd: repo,
      stdio: 'pipe',
    });
  } catch (err) {
    result.code = err.status == null ? 1 : err.status;
    result.stderr = err.stderr || '';
  }
  return result;
}

/**
 * Apply one round's scripted work to the repo. A failure here fails the fixture
 * loudly rather than being read as "this round changed nothing".
 *
 * `BANDAID_CLI` is exported so a round can do what a model would — record a
 * blocker, say — rather than only editing files.
 */
function applyRound(fixture, repo, script, home) {
  const result = spawnSync('bash', [path.join(fixture.roundsDir, script)], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 30_000,
    env: env(home, { BANDAID_CLI: CLI }),
  });
  if (result.status !== 0) {
    throw new Error(`round script ${script} exited ${result.status}: ${(result.stderr || '').slice(0, 300)}`);
  }
}

/**
 * One round of work done by a model instead of by a script.
 *
 * The prompt is the entire point of this tier. Round 1 gets the objective — what a
 * user types before the goal is set — and every round after gets the previous stop's
 * stderr *verbatim*: the continuation prompt, with whatever `--ablate` withheld
 * genuinely missing from it. Paraphrasing or reconstructing it here would measure a
 * prompt nobody ships.
 */
function runWorker({ prompt, repo, home, model, timeoutMs, cli = 'claude' }) {
  const workerEnv = {
    ...process.env,
    // The worker is itself a Claude Code session and would otherwise fire the very
    // hook under test on its own stop. Same guard runJudge and runCriteria take.
    BANDAID_ENABLED: '0',
    // The continuation prompt hands the model absolute `bandaid goal block` and
    // `goal complete` commands, and those read and write session state. Without this
    // they would resolve to the developer's real ~/.claude/bandaid: the harness would
    // report "the model never recorded a blocker" when it had, and the run would
    // scribble on live state to do it. The sandbox home is not an optimisation here.
    BANDAID_HOME: home,
  };
  // The harness's session id must not leak into the worker's own session. The prompt's
  // commands carry `--session` explicitly, so nothing needs it.
  delete workerEnv.CLAUDE_SESSION_ID;

  const result = spawnSync(
    cli,
    [
      '-p',
      prompt,
      '--model',
      model,
      // A worker that stops to ask has produced nothing, and a round that produced
      // nothing is indistinguishable from a model that chose not to act.
      '--permission-mode',
      'bypassPermissions',
      // The inverse of the judge's allowlist: the judge inspects and never edits, so
      // the worker is the one that has to. Task/Agent stay out because a subagent
      // would not inherit the guard above.
      '--allowedTools',
      'Read Grep Glob Edit Write Bash',
      '--disallowedTools',
      'Task Agent WebFetch WebSearch',
    ],
    { cwd: repo, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: workerEnv },
  );

  // A model that decides to do nothing is data. A worker that could not run is not,
  // and reading the second as the first is how a broken tier reports a confident null.
  if (result.error) throw new Error(`worker could not run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`worker exited ${result.status}: ${(result.stderr || '').slice(0, 300)}`);
  }
  return result.stdout || '';
}

function readGoal(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'sessions', SESSION, 'goal.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Why the loop ended, from the goal record rather than from the exit code.
 *
 * This is the diagnostic the whole harness exists to produce: a mechanism that ends
 * zero loops across every fixture is a mechanism to delete, and this row is where
 * that becomes visible.
 */
function endedBy(goal, released) {
  if (!goal) return 'no-goal';
  if (goal.status === 'complete') return /check passed/i.test(goal.note || '') ? 'check' : 'complete';
  if (goal.status === 'blocked') {
    // Three different things end as `blocked`, and collapsing them would hide the
    // one this fixture set exists to show: a goal whose visible check went green.
    if (goal.sealFailure) return 'seal';
    return /constraint/i.test(goal.note || '') ? 'violation' : 'blocker';
  }
  if (goal.status === 'budget_limited') {
    if (goal.plateau >= 2) return 'plateau';
    if ((goal.stalls || 0) >= 2) return 'stall';
    return 'budget';
  }
  return released ? 'released-active' : 'rounds-exhausted';
}

function runFixture(fixture, flags) {
  const { repo, home } = sandbox(fixture);
  const extraEnv = {
    BANDAID_GOAL_MODE: 'explicit',
    // A generous cap: this harness is measuring what ends a loop, so the round
    // count must not be the thing that does it unless nothing else will.
    BANDAID_MAX_CONTINUATIONS: String(flags.rounds * 3),
    // `ledger` and `seal` are not prompt blocks, so they are withheld by not
    // supplying them rather than by BANDAID_ABLATE. Passing either through would
    // name a block that does not exist and silently do nothing.
    ...(flags.ablate && !ABLATED_BY_ABSENCE.has(flags.ablate) ? { BANDAID_ABLATE: flags.ablate } : {}),
    ...(fixture.check ? { BANDAID_GOAL_CHECK: 'bash ./check.sh' } : {}),
    ...(fixture.seal && flags.ablate !== 'seal' ? { BANDAID_GOAL_SEAL: 'bash ./seal.sh' } : {}),
    // Twice opt-in: the fixture has to declare it wants a judge *and* the run has to
    // pass --judge. The judge costs a subprocess and 12–16s per stop and needs
    // `claude` on PATH, so the default run stays fast, offline and deterministic.
    ...(fixture.expected.judge && flags.judge ? { BANDAID_JUDGE: '1' } : {}),
  };

  try {
    const setArgs = ['goal', 'set', '--session', SESSION, '--cwd', repo];
    if (fixture.check) setArgs.push('--check', 'bash ./check.sh');
    setArgs.push('--', fixture.objective);
    execFileSync(process.execPath, [CLI, ...setArgs], { encoding: 'utf8', env: env(home, extraEnv), cwd: repo });

    if (fixture.criteria.length) {
      cli(['goal', 'criteria', '--session', SESSION, '--', ...fixture.criteria], home, repo);
    }

    let released = false;
    let round = 0;
    const log = [];
    const useModel = modelDriven(fixture, flags);
    // Round 1 is handed what a user types. Every round after is handed the previous
    // stop's continuation prompt, unmodified.
    let prompt = fixture.objective;

    while (round < flags.rounds) {
      // Work happens, then the turn tries to end — the real order.
      if (useModel) {
        runWorker({
          prompt,
          repo,
          home,
          model: flags.workerModel,
          timeoutMs: flags.workerTimeoutMs,
        });
      } else if (fixture.rounds[round]) {
        applyRound(fixture, repo, fixture.rounds[round], home);
      }
      round += 1;

      // A batch of tool calls, so the turn is not "trivial" and is worth auditing.
      execFileSync(
        process.execPath,
        [path.join(ROOT, 'src', 'hooks', 'post-tool-batch.js')],
        {
          input: JSON.stringify({
            session_id: SESSION,
            cwd: repo,
            tool_calls: [{ tool_name: 'Edit', tool_input: { file_path: 'src/x.js' }, tool_response: 'Applied 1 edit' }],
          }),
          encoding: 'utf8',
          env: env(home, extraEnv),
          cwd: repo,
        },
      );

      if (flags.ablate === 'ledger') clearLedger(home);
      const stop = runStop({ home, repo, extraEnv });
      log.push({ round, code: stop.code, stderrWords: stop.stderr.trim().split(/\s+/).filter(Boolean).length });

      if (stop.code === 0) {
        released = true;
        break;
      }

      // The next round reads exactly what this stop wrote. A blocked stop that wrote
      // no prompt is a harness fault, not a quiet round: it would hand the model the
      // *previous* round's prompt and report the result as if nothing had changed.
      if (useModel) {
        if (!stop.stderr.trim()) throw new Error(`round ${round} blocked but wrote no continuation prompt`);
        prompt = stop.stderr;
      }
    }

    const goal = readGoal(home);
    return {
      name: fixture.name,
      worker: useModel ? 'claude' : 'script',
      released,
      rounds: round,
      status: goal ? goal.status : null,
      endedBy: endedBy(goal, released),
      refunded: goal ? goal.refunded || 0 : 0,
      stalls: goal ? goal.stalls || 0 : 0,
      // Both counters, always, because "which mechanism ended this" is the question
      // brief 8 needs answered and the two can be true at once.
      plateau: goal ? goal.plateau || 0 : 0,
      blockedStreak: goal ? goal.blockedStreak || 0 : 0,
      note: goal ? goal.note || null : null,
      log,
      expected: fixture.expected,
    };
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/**
 * A fixture passes when the loop did what the fixture says it should. `releases`
 * is the load-bearing one: `false-done` must not release, and a harness that let it
 * would be reporting a false close as a success.
 */
function grade(result) {
  const problems = [];
  const want = result.expected || {};
  if (want.releases != null && want.releases !== result.released) {
    problems.push(`expected ${want.releases ? 'release' : 'no release'}, got ${result.released ? 'release' : 'none'}`);
  }
  if (want.byRound != null && result.released && result.rounds !== want.byRound) {
    problems.push(`expected release at round ${want.byRound}, got ${result.rounds}`);
  }
  if (want.status != null && result.status !== want.status) {
    problems.push(`expected status ${want.status}, got ${result.status}`);
  }
  // The false-close guard, and the reason `releases` alone is not enough: a loop
  // that gives up *does* release, so what must never happen is closing as complete.
  if (want.notStatus != null && result.status === want.notStatus) {
    problems.push(`must never end as ${want.notStatus}`);
  }
  return problems;
}

/**
 * Fold N samples of one fixture into a single row.
 *
 * A one-sample row is today's row exactly, plus `sampleCount`. Existing readers —
 * test/loop-harness.test.js reaches for `results[0].log[0].stderrWords` — must keep
 * working, so the extra fields appear only when there is more than one sample to
 * describe.
 */
function aggregate(samples, worker) {
  const first = samples[0];
  // Stamped from the run's configuration, not read off the first sample: a sample that
  // threw carries no `worker`, and grading the whole row as scripted because its first
  // attempt errored would apply a script's expectations to a model.
  if (samples.length === 1) return { ...first, worker, sampleCount: 1 };

  const ok = samples.filter((s) => !s.error);
  const endedByCounts = {};
  const statuses = {};
  for (const s of ok) {
    endedByCounts[s.endedBy] = (endedByCounts[s.endedBy] || 0) + 1;
    statuses[String(s.status)] = (statuses[String(s.status)] || 0) + 1;
  }

  return {
    ...first,
    worker,
    sampleCount: samples.length,
    errored: samples.length - ok.length,
    releaseRate: ok.length ? ok.filter((s) => s.released).length / ok.length : null,
    roundsMean: ok.length ? ok.reduce((sum, s) => sum + s.rounds, 0) / ok.length : null,
    statuses,
    endedByCounts,
    samples,
  };
}

/**
 * The same expectations, read against a model.
 *
 * Every `expected.json` in this suite describes what a *scripted* worker does, because
 * that is all there was to describe. `byRound: 3` is the clearest case: it is the pace
 * of `converging`'s three round scripts, not a property of the loop. A real model
 * implemented the same objective in one round on the first smoke run and was graded as
 * a failure for it, which is the expectation being wrong rather than the run.
 *
 * So a model-driven fixture is graded this way at *any* sample count, and the split is
 * by worker rather than by sample count:
 *
 * - `byRound` is dropped. A faster close is not a regression.
 * - `releases` and `status` become "at least one sample reached this", a distribution.
 * - `notStatus` stays absolute. A false close in even one sample is the finding this
 *   fixture set exists to catch, and averaging it into a rate would hide exactly the
 *   thing being measured.
 */
function gradeSamples(entry) {
  const want = entry.expected || {};
  // A one-sample model run still has a distribution; it just has one point in it.
  const samples = entry.samples || [entry];
  const ok = samples.filter((s) => !s.error);
  const problems = [];

  for (const s of samples) if (s.error) problems.push(s.error);
  if (!ok.length) return problems;

  if (want.notStatus != null) {
    const violations = ok.filter((s) => s.status === want.notStatus).length;
    if (violations) {
      problems.push(`ended as ${want.notStatus} in ${violations}/${ok.length} samples; must never`);
    }
  }
  if (want.releases === true && !ok.some((s) => s.released)) {
    problems.push(`expected release, got none in ${ok.length} samples`);
  }
  if (want.releases === false) {
    const releases = ok.filter((s) => s.released).length;
    if (releases) problems.push(`expected no release, got ${releases}/${ok.length}`);
  }
  if (want.status != null && !ok.some((s) => s.status === want.status)) {
    problems.push(`expected status ${want.status}, got none in ${ok.length} samples`);
  }
  return problems;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));

  // Fail loudly rather than silently running the scripted tier under a name the user
  // thought meant something else.
  if (flags.worker && flags.worker !== 'claude') {
    console.log(`\n  eval/loop: unknown worker "${flags.worker}". The only model tier is "claude".\n`);
    process.exitCode = 1;
    return;
  }

  let dirs;
  try {
    dirs = fs.readdirSync(FIXTURES).filter((d) => fs.statSync(path.join(FIXTURES, d)).isDirectory());
  } catch {
    console.log('\n  eval/loop: no fixtures found.\n');
    return;
  }
  if (flags.filter) dirs = dirs.filter((d) => d.includes(flags.filter));

  const results = [];
  for (const dir of dirs.sort()) {
    const fixture = loadFixture(dir);
    if (!fixture) continue;
    // A fixture that did not opt into the model worker is deterministic, so sampling
    // it N times would spend N× the wall clock to produce N identical rows.
    const useModel = modelDriven(fixture, flags);
    const runs = useModel ? flags.samples : 1;
    const samples = [];
    for (let i = 0; i < runs; i += 1) {
      try {
        samples.push(runFixture(fixture, flags));
      } catch (err) {
        samples.push({ name: dir, error: String(err.message || err), expected: fixture.expected });
      }
    }
    results.push(aggregate(samples, useModel ? 'claude' : 'script'));
  }

  if (flags.json) {
    console.log(JSON.stringify({ ablate: flags.ablate, results }, null, 2));
    return;
  }

  // Scripted rows are deterministic and graded strictly; model rows are graded as a
  // distribution. Splitting on the worker rather than the sample count is what keeps a
  // one-sample model run from being held to a scripted worker's round number.
  const graded = results.map((r) => ({
    ...r,
    problems: r.worker === 'claude' ? gradeSamples(r) : r.error ? [r.error] : grade(r),
  }));
  const correct = graded.filter((r) => !r.problems.length);

  console.log('');
  if (flags.ablate) console.log(`  ablating   ${flags.ablate}`);
  if (flags.worker) console.log(`  worker     ${flags.worker} · ${flags.workerModel} · ${flags.samples} sample(s)`);
  console.log(`  fixtures   ${graded.length}`);
  console.log(`  correct    ${correct.length}/${graded.length}`);
  console.log('');
  for (const r of graded) {
    const verdict = r.problems.length ? 'FAIL' : 'ok  ';
    let detail;
    if (r.sampleCount > 1) {
      const ended = Object.entries(r.endedByCounts)
        .map(([k, v]) => `${k} ${v}`)
        .join(' · ');
      // Rates, with the denominator inline: a bare percentage from five samples
      // reads like a measurement and is not one.
      detail =
        `${r.releaseRate == null ? '—' : `${Math.round(r.releaseRate * 100)}% released`}` +
        ` of ${r.sampleCount}` +
        `${r.roundsMean == null ? '' : ` · mean ${r.roundsMean.toFixed(1)} rounds`}` +
        `${ended ? ` · ${ended}` : ''}` +
        `${r.errored ? ` · ${r.errored} errored` : ''}`;
    } else if (r.error) {
      detail = r.error.slice(0, 60);
    } else {
      detail =
        `${r.released ? 'released' : 'held'} after ${r.rounds} round(s) · ended by ${r.endedBy}` +
        `${r.refunded ? ` · ${r.refunded} refunded` : ''}`;
    }
    console.log(`  ${verdict} ${r.name.padEnd(18)} ${detail}`);
    for (const problem of r.problems) console.log(`       ${problem}`);
  }

  // Asking for the model tier and getting the scripted one is the silent failure this
  // whole opt-in-twice design risks, so it is named rather than left to be noticed.
  if (flags.worker === 'claude' && !graded.some((r) => r.worker === 'claude')) {
    console.log('');
    console.log('  note       no selected fixture declares "worker": true — every row above is scripted');
  }

  // The row this harness exists for: which mechanisms never end a loop.
  //
  // Split two ways on purpose. "Fired zero times despite a fixture aiming at it" is
  // a finding — a mechanism to delete. "No fixture covers it" is a gap in this
  // suite and says nothing about the mechanism, and conflating the two would let a
  // coverage hole read as a deletion candidate.
  const counts = {};
  for (const r of graded) {
    // Every sample votes, not just the first one, or a mechanism that ended four of
    // five sampled loops would show up here as having ended one.
    for (const s of r.samples || [r]) if (s.endedBy) counts[s.endedBy] = (counts[s.endedBy] || 0) + 1;
  }
  const all = ['check', 'complete', 'stall', 'plateau', 'blocker', 'seal', 'violation', 'budget', 'rounds-exhausted'];
  const covered = new Set(graded.flatMap((r) => (r.expected && r.expected.covers) || []));

  console.log('');
  console.log(`  ended by   ${all.map((k) => `${k} ${counts[k] || 0}`).join(' · ')}`);

  const deadDespiteCoverage = all.filter((k) => !counts[k] && covered.has(k));
  const uncovered = all.filter((k) => !counts[k] && !covered.has(k));
  if (deadDespiteCoverage.length) {
    console.log(`  DEAD       ${deadDespiteCoverage.join(', ')}  — a fixture aims at it and it never fires`);
  }
  if (uncovered.length) {
    console.log(`  uncovered  ${uncovered.join(', ')}  — no fixture reaches these; says nothing about them`);
  }
  console.log('');

  if (correct.length !== graded.length) process.exitCode = 1;
}

main();
