'use strict';

const { spawnSync } = require('node:child_process');

const { groupBatchesByTurn, renderTurnDigest } = require('./digest');

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

const VERDICT_RE = /^[^\S\n]*VERDICT:[^\S\n]*(complete|continue)\b/im;
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

function judgePrompt({ objective, evidence, checkOutput, criteria = [] }) {
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

  return `You are auditing whether an engineer's work actually satisfies an objective. You did not do the work and you have no stake in it being finished.

<objective>
${objective}
</objective>

${rubric}${evidence ? `The engineer's tool log for this objective, which may be incomplete or self-flattering:\n\n<evidence>\n${evidence}\n</evidence>\n` : ''}${checkOutput ? `A verification command was run and passed. Its output:\n\n<check-output>\n${checkOutput}\n</check-output>\n` : ''}
Verify against the repository itself. Read the files, grep for the symbols, and confirm each requirement in the objective is really satisfied in the current state of the code. The log above is a claim, not proof — check it. Absence of obvious remaining work is not proof either; the objective must be positively satisfied.

Judge only the objective as written. Do not require work it does not ask for, and do not accept a narrower version of it.

Reply with exactly two lines and nothing else:
VERDICT: complete
REASON: <one sentence>

Use "complete" only if every requirement is verifiably satisfied right now. Otherwise use "continue" and make the REASON the single most important thing still missing, specific enough to act on.`;
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
function runJudge({ objective, evidence = '', checkOutput = null, criteria = [], cwd, model = 'haiku', timeoutMs = DEFAULT_TIMEOUT_MS, cli = 'claude' } = {}) {
  if (!objective) return null;

  const result = spawnSync(
    cli,
    [
      '-p',
      judgePrompt({ objective, evidence, checkOutput, criteria }),
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
function assess({ goal, config, cwd, turns = [], spawn = {} } = {}) {
  const settings = (config && config.goals) || {};
  const timeoutMs = settings.verifyTimeoutMs || DEFAULT_TIMEOUT_MS;
  const command = goal && goal.check != null ? goal.check : settings.check;
  const judgeEnabled = settings.judge === true;

  const check = (spawn.runCheck || runCheck)(command, { cwd, timeoutMs });

  // Ground truth outranks every opinion, including the judge's. If the command
  // says no, there is nothing left to deliberate.
  if (check && !check.ok) {
    return {
      proven: false,
      reason: `check failed: ${command}`,
      verification: { source: 'check', command, ok: false, output: check.output },
    };
  }

  if (judgeEnabled) {
    const verdict = (spawn.runJudge || runJudge)({
      objective: goal.objective,
      criteria: goal.criteria || [],
      evidence: evidenceFromTurns(turns),
      checkOutput: check ? check.output : null,
      cwd,
      model: settings.judgeModel || 'haiku',
      timeoutMs,
    });
    if (verdict) {
      return {
        proven: verdict.verdict === 'complete',
        reason: verdict.reason,
        verification: { source: 'judge', ok: verdict.verdict === 'complete', output: verdict.reason },
      };
    }
  }

  if (check && check.ok) {
    return {
      proven: true,
      reason: `check passed: ${command}`,
      verification: { source: 'check', command, ok: true, output: check.output },
    };
  }

  return { proven: false, reason: null, verification: null };
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
