'use strict';

/**
 * The loop harness itself.
 *
 * eval/run.js's header states the reason this file exists: "a judge that returns
 * 'complete' on a stubbed test is worse than no judge, because it launders a
 * model's self-assessment as an independent one." The same is true one level up. A
 * broken harness produces confident wrong numbers, and this one already did once —
 * its first version reported a MAPE-style figure from an unfinished session and its
 * `ended by` row mislabelled which mechanism stopped a loop.
 *
 * So: does it actually release when it should, does it fail loudly rather than
 * quietly, does it clean up after itself, and — the one that keeps every ablation
 * number honest — does `--ablate` really withhold the block it names?
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { after, describe, it } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const LOOP = path.join(ROOT, 'eval', 'loop.js');
const FIXTURES = path.join(ROOT, 'eval', 'loop-fixtures');

const scratch = [];
after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function runLoop(args, env = {}) {
  const out = execFileSync(process.execPath, [LOOP, ...args, '--json'], {
    encoding: 'utf8',
    cwd: ROOT,
    stdio: 'pipe',
    // Generous: each fixture spawns several subprocesses per round.
    timeout: 180_000,
    env: { ...process.env, ...env },
  });
  return JSON.parse(out);
}

/**
 * The rendered report rather than the JSON.
 *
 * `--json` returns before grading, so it is the only way to see a verdict — and a
 * failing verdict exits non-zero, which execFileSync throws on.
 */
function runLoopText(args, env = {}) {
  try {
    return execFileSync(process.execPath, [LOOP, ...args], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: 'pipe',
      timeout: 180_000,
      env: { ...process.env, ...env },
    });
  } catch (err) {
    return err.stdout || '';
  }
}

/**
 * A `claude` that is not Claude.
 *
 * The model tier must be testable without spending money or accepting a
 * nondeterministic answer, so these tests put a recorder on PATH under that name. It
 * writes down exactly what it was handed — argv and the environment that matters —
 * which is the only way to assert the property the whole tier rests on: that the
 * model reads the real continuation prompt, with the ablated block really missing.
 */
function stubWorker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-stub-worker-'));
  scratch.push(dir);
  const log = path.join(dir, 'calls');
  const bin = path.join(dir, 'claude');

  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const dir = ${JSON.stringify(log)};
fs.mkdirSync(dir, { recursive: true });
const n = fs.readdirSync(dir).length;
fs.writeFileSync(
  path.join(dir, String(n).padStart(3, '0') + '.json'),
  JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: {
      BANDAID_ENABLED: process.env.BANDAID_ENABLED ?? null,
      BANDAID_HOME: process.env.BANDAID_HOME ?? null,
      CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID ?? null,
    },
  }),
);
process.exit(0);
`,
  );
  fs.chmodSync(bin, 0o755);

  return {
    env: { PATH: `${dir}${path.delimiter}${process.env.PATH}` },
    calls() {
      let files;
      try {
        files = fs.readdirSync(log).sort();
      } catch {
        return [];
      }
      return files.map((f) => JSON.parse(fs.readFileSync(path.join(log, f), 'utf8')));
    },
  };
}

/** What the worker was handed as its prompt, which is the argument after `-p`. */
function promptOf(call) {
  return call.argv[call.argv.indexOf('-p') + 1];
}

/** A throwaway fixture written into the real fixtures dir, removed afterwards. */
function fixture(name, files) {
  const dir = path.join(FIXTURES, name);
  scratch.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return name;
}

describe('the shipped fixtures', () => {
  it('has a rounds script and an expectation for every one of them', () => {
    // A fixture with no expectation is graded against nothing and always passes,
    // which is how a suite quietly stops measuring.
    const dirs = fs
      .readdirSync(FIXTURES)
      .filter((d) => fs.statSync(path.join(FIXTURES, d)).isDirectory())
      .filter((d) => !d.startsWith('zz-'));

    assert.ok(dirs.length >= 6, `expected the six-plus shipped fixtures, found ${dirs.length}`);
    for (const dir of dirs) {
      assert.ok(fs.existsSync(path.join(FIXTURES, dir, 'objective.txt')), `${dir} has no objective`);
      const expected = path.join(FIXTURES, dir, 'expected.json');
      assert.ok(fs.existsSync(expected), `${dir} has no expected.json`);
      const want = JSON.parse(fs.readFileSync(expected, 'utf8'));
      assert.ok(
        want.releases != null || want.status != null || want.notStatus != null,
        `${dir}'s expectation asserts nothing`,
      );
    }
  });
});

describe('releasing', () => {
  it('releases at round 1 when the check already passes', () => {
    const name = fixture('zz-instant', {
      'objective.txt': 'Do the thing that is already done\n',
      'criteria.txt': 'the check exits 0\n',
      'repo/src/x.js': 'module.exports = {};\n',
      'check.sh': 'exit 0\n',
      'rounds/01.sh': 'true\n',
      'expected.json': '{"releases":true,"byRound":1,"status":"complete"}',
    });

    const { results } = runLoop(['--filter', name, '--rounds', '3']);
    const [result] = results;
    assert.equal(result.released, true);
    assert.equal(result.rounds, 1);
    assert.equal(result.status, 'complete');
    assert.equal(result.endedBy, 'check');
  });

  it('reports hitting the round cap as truncation, not as a release', () => {
    const name = fixture('zz-forever', {
      'objective.txt': 'Chase something unreachable\n',
      'criteria.txt': 'the check exits 0\n',
      'repo/src/x.js': 'module.exports = {};\n',
      // Output changes every round, so nothing converges and nothing repeats.
      'check.sh': 'echo "still $(cat src/n.txt 2>/dev/null | wc -c)"\nexit 1\n',
      'rounds/01.sh': 'echo x >> src/n.txt\n',
      'rounds/02.sh': 'echo xx >> src/n.txt\n',
      'expected.json': '{"notStatus":"complete"}',
    });

    const { results } = runLoop(['--filter', name, '--rounds', '2']);
    const [result] = results;
    assert.equal(result.released, false);
    assert.equal(result.endedBy, 'rounds-exhausted');
    assert.notEqual(result.status, 'complete');
  });
});

describe('failing loudly', () => {
  it('fails the fixture when a round script errors, rather than reading it as no change', () => {
    const name = fixture('zz-broken-round', {
      'objective.txt': 'Never mind\n',
      'repo/src/x.js': 'module.exports = {};\n',
      'rounds/01.sh': 'exit 3\n',
      'expected.json': '{"releases":false}',
    });

    const { results } = runLoop(['--filter', name, '--rounds', '2']);
    const [result] = results;
    assert.ok(result.error, 'a round that could not run must not be silently skipped');
    assert.match(result.error, /exited 3/);
  });

  it('leaves no temporary directory behind, even when a round fails', () => {
    const before = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('bandaid-loop-'));
    runLoop(['--filter', 'zz-broken-round', '--rounds', '2']);
    const after = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('bandaid-loop-'));
    assert.deepEqual(after, before, 'the sandbox is removed in a finally block for this reason');
  });
});

describe('ablation', () => {
  it('genuinely withholds the block it names, which is what keeps the numbers honest', () => {
    // Measured through the recorded prompt length: withholding the 277-word
    // completion audit has to make the prompt materially shorter. An --ablate flag
    // that silently did nothing would report "no effect" for every block.
    const name = fixture('zz-ablate', {
      'objective.txt': 'Something that will not finish this round\n',
      'criteria.txt': 'the check exits 0\n',
      'repo/src/x.js': 'module.exports = {};\n',
      'check.sh': 'echo "not yet"\nexit 1\n',
      'rounds/01.sh': 'true\n',
      'expected.json': '{"notStatus":"complete"}',
    });

    const full = runLoop(['--filter', name, '--rounds', '1']).results[0].log[0].stderrWords;
    const cut = runLoop(['--filter', name, '--rounds', '1', '--ablate', 'completion-audit']).results[0].log[0]
      .stderrWords;

    assert.ok(full > 0, 'the unablated round produced a prompt');
    assert.ok(
      full - cut > 200,
      `withholding the completion audit changed the prompt by only ${full - cut} words; it is ~277`,
    );
  });
});

describe('the model worker', () => {
  /** Never releases, so every round produces a continuation prompt to inspect. */
  const stuck = {
    'objective.txt': 'Do the unreachable thing\n',
    'criteria.txt': 'the check exits 0\n',
    'repo/src/x.js': 'module.exports = {};\n',
    'check.sh': 'echo "not yet"\nexit 1\n',
    'expected.json': '{"notStatus":"complete","worker":true}',
  };

  it('hands round 1 the objective and every round after it the previous continuation prompt', () => {
    const name = fixture('zz-worker-prompt', stuck);
    const stub = stubWorker();

    // One sample: this is about the shape of a single round's call, and --worker on
    // its own would take five of them.
    runLoop(['--filter', name, '--rounds', '2', '--worker', 'claude', '--samples', '1'], stub.env);

    const calls = stub.calls();
    assert.equal(calls.length, 2, 'one worker call per round');
    assert.equal(promptOf(calls[0]), 'Do the unreachable thing', 'round 1 gets what a user types');
    assert.match(
      promptOf(calls[1]),
      /\[Bandaid\] Continue working toward the active goal/,
      'round 2 gets the real continuation prompt, not a paraphrase of it',
    );
  });

  it('really withholds the ablated block from what the model reads', () => {
    // The assertion the whole tier rests on. If --ablate stopped working, every
    // future run would report "no effect" for every block and look like a finding.
    const name = fixture('zz-worker-ablate', stuck);

    const full = stubWorker();
    runLoop(['--filter', name, '--rounds', '2', '--worker', 'claude', '--samples', '1'], full.env);
    assert.match(promptOf(full.calls()[1]), /Completion audit:/);

    const cut = stubWorker();
    runLoop(
      ['--filter', name, '--rounds', '2', '--worker', 'claude', '--samples', '1', '--ablate', 'completion-audit'],
      cut.env,
    );
    assert.doesNotMatch(
      promptOf(cut.calls()[1]),
      /Completion audit:/,
      'the model was still handed the block the run claimed to withhold',
    );
  });

  it('disarms Bandaid inside the worker and points it at the sandbox, not the real home', () => {
    const name = fixture('zz-worker-env', stuck);
    const stub = stubWorker();

    runLoop(['--filter', name, '--rounds', '1', '--worker', 'claude', '--samples', '1'], stub.env);

    const [call] = stub.calls();
    // Without this the worker is a Claude Code session that fires the hook under test.
    assert.equal(call.env.BANDAID_ENABLED, '0');
    // The prompt hands the model absolute `goal block` / `goal complete` commands.
    // Pointed anywhere but the sandbox they would write to live state, and the
    // harness would report that the model never ran them.
    assert.match(call.env.BANDAID_HOME, /bandaid-loop-home-/);
    assert.equal(call.env.CLAUDE_SESSION_ID, null, "the harness's session must not leak into the worker's");
  });

  it('lets the worker edit but never spawn a subagent', () => {
    const name = fixture('zz-worker-tools', stuck);
    const stub = stubWorker();

    runLoop(['--filter', name, '--rounds', '1', '--worker', 'claude', '--samples', '1'], stub.env);

    const [call] = stub.calls();
    const allowed = call.argv[call.argv.indexOf('--allowedTools') + 1];
    const denied = call.argv[call.argv.indexOf('--disallowedTools') + 1];

    // The inverse of the judge's allowlist: the judge inspects, the worker works.
    for (const tool of ['Edit', 'Write', 'Bash']) assert.match(allowed, new RegExp(tool));
    // A subagent would not inherit BANDAID_ENABLED=0.
    for (const tool of ['Task', 'Agent']) assert.match(denied, new RegExp(tool));
    // A worker that stops to ask produces a round that did nothing, which is
    // indistinguishable from a model that chose to do nothing.
    assert.equal(call.argv[call.argv.indexOf('--permission-mode') + 1], 'bypassPermissions');
  });

  it('costs nothing and calls nothing when the flag is absent', () => {
    // The fixture opts in; the run does not. Opt-in-twice means neither alone fires.
    const name = fixture('zz-worker-optout', stuck);
    const stub = stubWorker();

    const { results } = runLoop(['--filter', name, '--rounds', '2'], stub.env);

    assert.equal(stub.calls().length, 0, 'the model tier ran without being asked for');
    assert.equal(results[0].worker, 'script');
    assert.equal(results[0].sampleCount, 1, 'the deterministic tier is never sampled');
  });

  it('samples a model-driven fixture and leaves the scripted ones alone', () => {
    const name = fixture('zz-worker-samples', stuck);
    const stub = stubWorker();

    const { results } = runLoop(['--filter', name, '--rounds', '1', '--worker', 'claude', '--samples', '3'], stub.env);

    const [entry] = results;
    assert.equal(entry.sampleCount, 3);
    assert.equal(entry.samples.length, 3);
    assert.equal(stub.calls().length, 3, 'one worker call per sample at one round each');
    assert.equal(entry.releaseRate, 0, 'nothing released, so the rate is 0 rather than absent');
    assert.equal(entry.roundsMean, 1);
  });

  it('samples five times by default, because one run of a nondeterministic worker is an anecdote', () => {
    const name = fixture('zz-worker-default-samples', stuck);
    const stub = stubWorker();

    const { results } = runLoop(['--filter', name, '--rounds', '1', '--worker', 'claude'], stub.env);

    assert.equal(results[0].sampleCount, 5);
    assert.equal(stub.calls().length, 5);
  });

  it('does not hold a model to the scripted worker\'s round number', () => {
    // The first smoke run against a real model failed exactly here: `converging`
    // expects `byRound: 3` because its three round scripts take three rounds, and a
    // model that implemented the same objective in one was graded as a regression for
    // finishing early. `byRound` describes the script, so the model tier drops it.
    const name = fixture('zz-worker-fast', {
      'objective.txt': 'Do the thing that is already done\n',
      'criteria.txt': 'the check exits 0\n',
      'repo/src/x.js': 'module.exports = {};\n',
      'check.sh': 'exit 0\n',
      'expected.json': '{"releases":true,"byRound":3,"status":"complete","worker":true}',
    });
    const stub = stubWorker();

    const out = runLoopText(['--filter', name, '--rounds', '3', '--worker', 'claude', '--samples', '1'], stub.env);

    assert.match(out, /correct {4}1\/1/);
    assert.doesNotMatch(out, /expected release at round 3/);
  });

  it('still holds the scripted worker to it', () => {
    // The other half of the same rule: dropping byRound for everyone would delete a
    // real assertion from the deterministic tier, where the round number is a fact.
    const name = fixture('zz-script-fast', {
      'objective.txt': 'Do the thing that is already done\n',
      'criteria.txt': 'the check exits 0\n',
      'repo/src/x.js': 'module.exports = {};\n',
      'check.sh': 'exit 0\n',
      'rounds/01.sh': 'true\n',
      'expected.json': '{"releases":true,"byRound":3,"status":"complete"}',
    });

    const out = runLoopText(['--filter', name, '--rounds', '3']);

    assert.match(out, /expected release at round 3, got 1/);
  });

  it('fails a fixture whose forbidden status appears in even one sample', () => {
    // Averaging a false close into a rate would hide precisely what is being measured.
    const name = fixture('zz-worker-neverclose', {
      'objective.txt': 'Do the thing that is already done\n',
      'criteria.txt': 'the check exits 0\n',
      'repo/src/x.js': 'module.exports = {};\n',
      'check.sh': 'exit 0\n',
      'expected.json': '{"notStatus":"complete","worker":true}',
    });
    const stub = stubWorker();

    const out = runLoopText(['--filter', name, '--rounds', '1', '--worker', 'claude', '--samples', '2'], stub.env);

    assert.match(out, /correct {4}0\/1/);
    assert.match(out, /ended as complete in 2\/2 samples; must never/);
  });

  it('refuses a worker it does not have rather than quietly running the scripted one', () => {
    const out = runLoopText(['--filter', 'zz-worker-prompt', '--worker', 'gpt']);
    assert.match(out, /unknown worker "gpt"/);
  });
});
