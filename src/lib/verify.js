'use strict';

const { spawnSync } = require('node:child_process');

const { groupBatchesByTurn, renderTurnDigest } = require('./digest');

// Lazily required: `verify` is loaded by the stop decision path, and neither of
// these has anything to say until a goal actually carries expectations, a
// scope, or a project with a manifest.
const selfcheck = () => require('./selfcheck');
const probesModule = () => require('./probes');

/**
 * Verification tiers above the continuation audit.
 *
 * The audit prompt Bandaid ports from Codex asks the model that did the work to
 * grade the work. That is the one failure prompt engineering cannot reach: a
 * model already convinced it is finished reads its own evidence charitably, and
 * the audit becomes a formality it passes. Codex has no answer for this and
 * neither does Claude Code's own `/goal`, whose judge only ever sees the
 * transcript — so it cannot check a claim the transcript does not contain, and
 * goes blind the moment a compaction summarizes that transcript away.
 *
 * Two tiers sit in front of the stop, both outside the model:
 *
 *   check — a shell command the user supplies. Exit 0 is proof; anything else
 *           is a veto no amount of model confidence can talk its way past.
 *   judge — a separate headless Claude, read-only, that inspects the worktree
 *           instead of the conversation. Compaction cannot blind it because it
 *           never reads the conversation in the first place.
 *
 * Failure policy differs on purpose. A check that cannot run is not proof, so
 * it fails closed. A judge that cannot run is merely absent, so it fails open
 * and Bandaid degrades to exactly the behaviour it had without this file.
 */

const OUTPUT_TAIL_CHARS = 2000;
const EVIDENCE_MAX_TOKENS = 4000;
const DEFAULT_TIMEOUT_MS = 120000;

const VERDICT_RE = /^[^\S\n]*VERDICT:[^\S\n]*(complete|continue|violated)\b/im;
const REASON_RE = /^[^\S\n]*REASON:[^\S\n]*(.+)$/im;

/** Keep the tail: a test runner puts the part you need at the end. */
function tail(text, limit = OUTPUT_TAIL_CHARS) {
  const trimmed = String(text == null ? '' : text).trim();
  if (trimmed.length <= limit) return trimmed;
  return `…(earlier output trimmed)\n${trimmed.slice(-limit)}`;
}

/**
 * Tier 1. Returns `{ ok, output, status }`, or null when no check is configured.
 * Anything other than a clean exit 0 is `ok: false` — a check that times out or
 * cannot be spawned has not proven anything, and silence is not evidence.
 */
function runCheck(command, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cmd = String(command == null ? '' : command).trim();
  if (!cmd) return null;

  const result = spawnSync(cmd, {
    shell: true,
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });

  const output = tail([result.stdout, result.stderr].filter(Boolean).join('\n'));

  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT' || result.signal === 'SIGTERM';
    return {
      ok: false,
      status: null,
      output: output || (timedOut ? `check timed out after ${timeoutMs}ms` : String(result.error.message || result.error)),
    };
  }

  return { ok: result.status === 0, status: result.status, output };
}

/** The turn record Bandaid already keeps, rendered as an evidence log. */
function evidenceFromTurns(turns, { maxTokens = EVIDENCE_MAX_TOKENS } = {}) {
  const grouped = groupBatchesByTurn(turns || [], []);
  const rendered = grouped
    .map((turn) => renderTurnDigest(turn, { maxTokens }))
    .filter(Boolean)
    .map((digest) => digest.text);
  if (!rendered.length) return '';
  // Newest turns are the ones worth the judge's attention.
  return tail(rendered.join('\n\n'), maxTokens * 4);
}

function judgePrompt({ objective, evidence, checkOutput, criteria = [], constraints = [], blockers = [], ledger = '' }) {
  // The same fixed list the worker is graded against. Without it the judge
  // derives its own reading of the objective, so a "continue" this turn and a
  // "continue" next turn are not necessarily about the same bar — which also
  // makes the plateau counter compare reasons drawn from a moving rubric.
  const rubric = (criteria || []).length
    ? `The acceptance criteria, fixed when the goal was set. Judge against these and only these:

<acceptance-criteria>
${criteria.map((text, i) => `${i + 1}. ${text}`).join('\n')}
</acceptance-criteria>
`
    : '';

  // The objective's negative half. A judge told only what to look for grades
  // work that satisfied every criterion by breaking the one thing the objective
  // said to leave alone as a success.
  const vetoes = (constraints || []).length
    ? `Constraints from the same objective. These are vetoes: work that satisfies every criterion while breaking one of these has failed, not partly succeeded.

<constraints>
${constraints.map((text) => `- ${text}`).join('\n')}
</constraints>

Check each constraint against the repository as actively as you check the criteria. Go and look at what it names. A constraint protecting something is broken when that thing is missing, emptied, or rewritten — and something that was deleted leaves no trace of itself, so look for what still references it: manifests, lockfiles, imports, config, and documentation that point at a path nothing is at any more.
`
    : '';

  // Reported impossible from here. Left in, the judge names them as missing
  // every round, the engineer records them as blocked every round, and the loop
  // spends its budget on a disagreement neither side can resolve.
  const walled = (blockers || []).length
    ? `Recorded as blocked by the environment — hardware, services, credentials, or interactions this session does not have. Do not count these against completion, and do not ask for them:

<recorded-blockers>
${blockers.map((text) => `- ${text}`).join('\n')}
</recorded-blockers>
`
    : '';

  return `You are auditing whether an engineer's work actually satisfies an objective. You did not do the work and you have no stake in it being finished.

<objective>
${objective}
</objective>

${rubric}${vetoes}${walled}${ledger ? `${ledger}\n` : ''}${evidence ? `The engineer's tool log for this objective, which may be incomplete or self-flattering:\n\n<evidence>\n${evidence}\n</evidence>\n` : ''}${checkOutput ? `A verification command was run and passed. Its output:\n\n<check-output>\n${checkOutput}\n</check-output>\n` : ''}
Verify against the repository itself. Read the files, grep for the symbols, and confirm each requirement in the objective is really satisfied in the current state of the code. The log above is a claim, not proof — check it. Absence of obvious remaining work is not proof either; the objective must be positively satisfied.

Judge only the objective as written. Do not require work it does not ask for, and do not accept a narrower version of it.

Reply with exactly two lines and nothing else:
VERDICT: complete
REASON: <one sentence>

Use "complete" only if every requirement is verifiably satisfied right now.${
    vetoes
      ? `
Use "violated" if the current state of the repository breaks one of the constraints above, and name which one in the REASON. Prefer "violated" over "continue" when both apply: unfinished work earns another attempt, a broken constraint does not.`
      : ''
  }
Otherwise use "continue" and make the REASON the single most important thing still missing, specific enough to act on.`;
}

function parseVerdict(stdout) {
  const verdict = VERDICT_RE.exec(String(stdout || ''));
  if (!verdict) return null;
  const reason = REASON_RE.exec(String(stdout || ''));
  return {
    verdict: verdict[1].toLowerCase(),
    reason: reason ? reason[1].trim() : null,
  };
}

/**
 * Tier 2. Returns `{ verdict, reason }` or null for "no opinion" — a missing
 * CLI, a crash, a timeout, or output that does not follow the contract all mean
 * the judge simply does not vote.
 */
function runJudge({ objective, evidence = '', checkOutput = null, criteria = [], constraints = [], blockers = [], ledger = '', cwd, model = 'haiku', timeoutMs = DEFAULT_TIMEOUT_MS, cli = 'claude' } = {}) {
  if (!objective) return null;

  const result = spawnSync(
    cli,
    [
      '-p',
      judgePrompt({ objective, evidence, checkOutput, criteria, constraints, blockers, ledger }),
      '--model',
      model,
      '--allowedTools',
      'Read Grep Glob',
      // The judge inspects; it never edits. Belt and braces with the allowlist.
      '--disallowedTools',
      'Edit Write NotebookEdit Bash Task Agent',
    ],
    {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      // The judge is itself a Claude Code session, and it would otherwise fire
      // this very hook on its own stop. Disarming Bandaid inside it is what
      // keeps a verification from recursing into another verification.
      env: { ...process.env, BANDAID_ENABLED: '0' },
    },
  );

  if (result.error || result.status !== 0) return null;
  return parseVerdict(result.stdout);
}

/**
 * Run the tiers that are configured and report whether the goal is proven done.
 *
 * With neither a check nor a judge this returns "not proven, no reason", which
 * is precisely Bandaid's original behaviour: block, and let the audit prompt do
 * the work.
 */
/**
 * What the ledger has to say about this objective, and how to write to it.
 *
 * Both are no-ops unless the goal carries a project root, which is what keeps
 * `assess` a pure function for the eval harness and every existing test: a
 * synthetic goal has no project, so nothing is read and nothing is written.
 */
function ledgerFor(goal, cwd) {
  if (!goal || !goal.projectRoot) return { text: '', record: () => {}, stamp: null };

  const evidence = require('./evidence');
  const { worktreeStamp } = require('./stamp');

  let stamp = null;
  let text = '';
  try {
    stamp = worktreeStamp(goal.projectRoot);
    const entries = evidence.read(goal.projectRoot, { objectiveHash: evidence.objectiveHash(goal.objective) });
    text = evidence.render(entries, { currentStamp: stamp });
  } catch {
    /* a ledger that cannot be read is simply absent */
  }

  const record = (entry) => {
    try {
      evidence.append(goal.projectRoot, {
        ...entry,
        objectiveHash: evidence.objectiveHash(goal.objective),
        stamp: stamp ? stamp.fp : null,
      });
    } catch {
      /* never at the cost of the verdict */
    }
  };

  return { text, record, stamp, cwd };
}

function assess({ goal, config, cwd, turns = [], spawn = {}, record = false } = {}) {
  const settings = (config && config.goals) || {};
  const timeoutMs = settings.verifyTimeoutMs || DEFAULT_TIMEOUT_MS;
  const command = goal && goal.check != null ? goal.check : settings.check;
  const judgeEnabled = settings.judge === true;

  const ledger = record ? ledgerFor(goal, cwd) : { text: '', record: () => {} };
  // Deliberately short. This goes into a one-line reason that is compared for
  // equality across rounds and stored on the goal; the full output already reaches
  // the model through `verification.output`.
  const firstLine = (text) => {
    const line = String(text || '')
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean);
    return line ? line.slice(0, 120) : '';
  };
  const check = (spawn.runCheck || runCheck)(command, { cwd, timeoutMs });

  // Ground truth outranks every opinion, including the judge's. If the command
  // says no, there is nothing left to deliberate.
  if (check && !check.ok) {
    ledger.record({
      kind: 'check',
      claim: `check \`${command}\` did not succeed`,
      pointers: [`cmd:${command}`],
      verdict: 'refuted',
      detail: check.output,
    });
    return {
      proven: false,
      // The output, not just the command. This looks cosmetic and is not: the
      // reason is what plateauReached compares for byte-equality and what
      // progress.detect compares for change. With only the command in it, the
      // string is *constant* for a given goal, so the plateau breaker fired after
      // any two consecutive failing rounds — killing a loop making visible
      // progress — while "the verdict changed" could never fire at all.
      //
      // eval/loop.js caught this: a goal landing one of four stages per round,
      // with the check output differing every round, was terminated at round 3
      // before it could go green at round 4.
      reason: `check failed: ${command}${check.output ? ` — ${firstLine(check.output)}` : ''}`,
      verification: { source: 'check', command, ok: false, output: check.output },
    };
  }

  if (check && check.ok) {
    ledger.record({
      kind: 'check',
      claim: `check \`${command}\` exited 0`,
      pointers: [`cmd:${command}`],
      verdict: 'supported',
      detail: check.output,
    });
  }

  // The model's own predictions, made while the work happened rather than
  // recalled at the end of it. Cheapest verifier here: no model, no subprocess
  // beyond the commands it was told to run.
  const expectations = (spawn.runExpectations || selfcheck().runExpectations)(goal, { cwd });
  if (expectations.verdict === 'fail') {
    const rendered = selfcheck().renderFailures(expectations.failures);
    ledger.record({
      kind: 'expect',
      claim: `${expectations.failures.length} of ${expectations.checked} recorded expectation(s) did not hold`,
      verdict: 'refuted',
      detail: rendered,
    });
    return {
      proven: false,
      reason: `expectation failed: ${expectations.failures[0].expected}`,
      verification: { source: 'expect', ok: false, output: rendered },
    };
  }

  // Paths this goal said it would not touch, and did.
  const scope = (spawn.checkScope || selfcheck().checkScope)(goal, { cwd });
  if (scope.verdict === 'fail') {
    const rendered = scope.violations.map((f) => `  ${f}`).join('\n');
    ledger.record({
      kind: 'expect',
      claim: `${scope.violations.length} file(s) changed outside the declared scope`,
      verdict: 'refuted',
      detail: rendered,
    });
    return {
      proven: false,
      reason: `changed outside the declared scope: ${scope.violations.slice(0, 3).join(', ')}`,
      verification: { source: 'scope', ok: false, output: rendered },
    };
  }

  // Probes veto but never prove, so a failing one blocks and a passing one is
  // simply not an argument for closing the goal.
  const probeResult = (spawn.assessProbes || probesModule().assessProbes)({ goal, config, cwd });
  if (probeResult.verdict === 'fail') {
    const first = probeResult.failures[0];
    const rendered = probeResult.failures
      .map((f) => `  ${f.probeId}: ${f.summary || `exited ${f.exitCode}`}`)
      .join('\n');
    ledger.record({
      kind: 'probe',
      claim: `probe \`${first.probeId}\` failed: ${first.summary || `exit ${first.exitCode}`}`,
      pointers: (first.artifacts || []).map((a) => `artifact:${a}`),
      verdict: 'refuted',
      detail: rendered,
    });
    return {
      proven: false,
      reason: `probe failed: ${first.probeId} — ${first.summary || `exit ${first.exitCode}`}`,
      verification: { source: 'probe', probeId: first.probeId, ok: false, output: rendered },
      probes: probeResult,
    };
  }

  for (const passed of probeResult.passed || []) {
    ledger.record({
      kind: 'probe',
      claim: `probe \`${passed.probeId}\` passed${passed.summary ? `: ${passed.summary}` : ''}`,
      pointers: (passed.artifacts || []).map((a) => `artifact:${a}`),
      verdict: 'supported',
    });
  }

  if (judgeEnabled) {
    const verdict = (spawn.runJudge || runJudge)({
      objective: goal.objective,
      criteria: goal.criteria || [],
      constraints: goal.constraints || [],
      blockers: goal.blockers || [],
      // The ledger goes ahead of the session digest: it is the only thing that
      // knows what happened on the days this session was not running.
      ledger: ledger.text,
      evidence: evidenceFromTurns(turns),
      checkOutput: check ? check.output : null,
      cwd,
      model: settings.judgeModel || 'haiku',
      cli: settings.judgeCli || 'claude',
      timeoutMs,
    });
    if (verdict) {
      const proven = verdict.verdict === 'complete';
      ledger.record({
        kind: 'judge',
        claim: verdict.reason || `judge returned ${verdict.verdict}`,
        verdict: proven ? 'supported' : 'refuted',
        detail: verdict.verdict,
      });
      return {
        proven,
        // A violation is not a smaller kind of "continue". Nothing the next turn
        // can do makes it untrue, so it leaves the loop rather than extending it.
        violated: verdict.verdict === 'violated',
        reason: verdict.reason,
        verification: { source: 'judge', ok: proven, output: verdict.reason },
      };
    }
  }

  if (check && check.ok) {
    return {
      proven: true,
      reason: `check passed: ${command}`,
      verification: { source: 'check', command, ok: true, output: check.output },
      probes: probeResult,
    };
  }

  return { proven: false, reason: null, verification: null, probes: probeResult };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  assess,
  evidenceFromTurns,
  judgePrompt,
  parseVerdict,
  runCheck,
  runJudge,
  tail,
};
