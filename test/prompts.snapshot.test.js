'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const { DEFAULTS } = require('../src/lib/config');
const { newGoal } = require('../src/lib/goals');
const { buildRestoreBlock } = require('../src/lib/restore');
const { criteriaPrompt, judgePrompt } = require('../src/lib/verify');
const {
  COMPACTION_FIDELITY_ADDENDUM,
  SUMMARIZATION_PROMPT,
  budgetLimitPrompt,
  continuationPrompt,
  openObjectivePrompt,
  probePendingPrompt,
  sealPrompt,
  violationPrompt,
} = require('../src/lib/prompts');

/**
 * Golden files for every prompt Bandaid injects.
 *
 * Roughly a thousand words of instruction reach the model, and until this file
 * existed a change to any of it broke no test — so nobody could see a prompt
 * edit in review, and nobody could tell whether a paragraph still earned its
 * place. These snapshots do not claim the prompts are good. They make changing
 * one visible, which is the precondition for ever finding out.
 *
 * Refresh deliberately, and read the diff:  UPDATE_SNAPSHOTS=1 npm test
 */

const DIR = path.join(__dirname, '..', 'eval', 'snapshots');
const UPDATE = Boolean(process.env.UPDATE_SNAPSHOTS);

function matchesSnapshot(name, actual) {
  const file = path.join(DIR, `${name}.txt`);
  if (UPDATE || !fs.existsSync(file)) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, actual);
    return;
  }
  const expected = fs.readFileSync(file, 'utf8');
  assert.equal(
    actual,
    expected,
    `${name} drifted from eval/snapshots/${name}.txt.\nIf the change is intended: UPDATE_SNAPSHOTS=1 npm test`,
  );
}

// Fixed inputs: nothing here may depend on the clock, cwd, or the environment.
// `newGoal` reads git for baseSha and the project root, so both are pinned —
// neither is rendered today, and a snapshot that silently depends on which
// worktree ran it is a snapshot that fails on someone else's machine.
const base = {
  ...newGoal('Port the retry logic to the new client', { maxContinuations: 2 }),
  baseSha: null,
  projectRoot: null,
  continuations: 1,
  // newGoal stamps startedAt from the clock, and the elapsed block renders from
  // it. Pinning it to null is what keeps these goldens byte-stable — a clause
  // with no input is absent, so the whole block disappears here and appears only
  // in the two goldens below that supply a fixed clock on purpose.
  startedAt: null,
  createdAt: null,
  lastProgressAt: null,
  continuationAt: [],
};

// A goal with a clock, for the goldens that exercise the elapsed block. `now` and
// the UTC offset are both explicit so this renders identically on every machine.
const CLOCK_NOW = Date.parse('2026-07-30T16:42:00.000Z');
const withClock = {
  ...base,
  startedAt: '2026-07-30T13:24:00.000Z',
  lastProgressAt: '2026-07-30T16:31:00.000Z',
};
const clockOpts = { ...({}), now: CLOCK_NOW, offsetMinutes: 0 };
const withCriteria = {
  ...base,
  criteria: ['npm test exits 0', 'src/client.js no longer references retryLegacy', 'the backoff delays actually grow'],
  criteriaSource: 'model',
};
const opts = { completeCommand: 'node /bandaid.js goal complete --session S', criteriaCommand: 'node /bandaid.js goal criteria --session S "first" "second"' };

const OPEN_RECORD = {
  projectRoot: '/repo',
  sessionId: 'S1',
  updatedAt: '2026-07-25T09:12:00.000Z',
  goal: {
    objective: 'Replace the polling sync with a websocket transport, do not break the REST fallback',
    criteria: ['src/sync/ws.js exists and the client connects on start', 'test/sync-fallback.test.js still passes'],
    constraints: ['do not break the REST fallback'],
    blockers: ['the staging websocket endpoint needs a VPN this session cannot reach'],
    blockedStreak: 1,
    status: 'active',
    sessions: ['S1', 'S2', 'S3'],
  },
};

const { render: renderLedger } = require('../src/lib/evidence');
const LEDGER = renderLedger(
  [
    { ts: '2026-07-26T14:31:00Z', criterion: 1, kind: 'check', verdict: 'supported', claim: 'check `npm test` exited 0', pointers: ['cmd:npm test'], stamp: 'now' },
    { ts: '2026-07-26T14:02:00Z', criterion: 2, kind: 'claim', verdict: 'unverified', claim: 'the migration is idempotent', pointers: ['src/migrate.js:88'], stamp: 'now' },
    { ts: '2026-07-25T09:11:00Z', criterion: 1, kind: 'check', verdict: 'refuted', claim: 'check `npm test` did not succeed', pointers: ['cmd:npm test'], stamp: 'then' },
  ],
  { currentStamp: { fp: 'now', method: 'git' } },
);

describe('prompt snapshots', () => {
  it('open objective — offered to a session that has not taken it up', () => {
    matchesSnapshot(
      'open-objective-offer',
      openObjectivePrompt(OPEN_RECORD, {
        adopted: false,
        adoptCommand: 'node /bandaid.js goal adopt --session S',
        clearCommand: 'node /bandaid.js goal clear --project',
        ageDays: 2,
      }),
    );
  });

  it('open objective — adopted outright in unattended mode', () => {
    matchesSnapshot('open-objective-adopted', openObjectivePrompt(OPEN_RECORD, { adopted: true, ageDays: 1 }));
  });

  it('continuation — no criteria recorded yet', () => {
    matchesSnapshot('continuation-bare', continuationPrompt(base, opts));
  });

  it('continuation — criteria fixed', () => {
    matchesSnapshot('continuation-criteria', continuationPrompt(withCriteria, opts));
  });

  // The elapsed block, which the goldens above must not contain: with no
  // startedAt every clause has no input, so the whole block disappears. These two
  // supply a fixed clock and a fixed UTC offset on purpose.
  it('continuation — elapsed, with no wall-clock budget', () => {
    matchesSnapshot('continuation-elapsed', continuationPrompt(withClock, { ...opts, ...clockOpts }));
  });

  it('continuation — elapsed against a wall-clock budget', () => {
    matchesSnapshot(
      'continuation-elapsed-budgeted',
      continuationPrompt({ ...withClock, timeBudgetMs: 6 * 60 * 60 * 1000 }, { ...opts, ...clockOpts }),
    );
  });

  it('continuation — the turn ended asking permission', () => {
    matchesSnapshot(
      'continuation-asked-permission',
      continuationPrompt(base, {
        ...opts,
        askedPermission: true,
        blockCommand: 'node /bandaid.js goal block --session S "what is blocked"',
      }),
    );
  });

  it('continuation — a check command failed', () => {
    const verification = { source: 'check', command: 'npm test', ok: false, output: '1 failing\n  retries with backoff' };
    matchesSnapshot('continuation-check-failed', continuationPrompt(withCriteria, { ...opts, verification, checkCommand: 'npm test' }));
  });

  it('continuation — the judge found something missing', () => {
    const verification = { source: 'judge', ok: false, output: 'src/client.js still calls retryLegacy on the timeout path.' };
    matchesSnapshot('continuation-judge-finding', continuationPrompt(withCriteria, { ...opts, verification }));
  });

  it('continuation — a check is configured and passing', () => {
    matchesSnapshot('continuation-check-configured', continuationPrompt(withCriteria, { ...opts, checkCommand: 'npm test' }));
  });

  it('continuation — constraints and recorded blockers', () => {
    const goal = {
      ...withCriteria,
      constraints: ['do NOT touch the billing module'],
      blockers: ['confirming the retry timing needs a live upstream this session cannot reach'],
    };
    matchesSnapshot(
      'continuation-blocked',
      continuationPrompt(goal, { ...opts, blockCommand: 'node /bandaid.js goal block --session S "what is blocked"' }),
    );
  });

  it('continuation — the ledger reports the score', () => {
    matchesSnapshot(
      'continuation-evidence',
      continuationPrompt(withCriteria, {
        ...opts,
        evidenceSummary: 'Evidence by criterion: 1 measured · 2 asserted but not measured · 3 no evidence.',
        evidenceCommand: 'node /bandaid.js evidence add --session S --criterion N --pointer file.js:12 -- "what is now true"',
      }),
    );
  });

  it('judge — reading the ledger as well as the worktree', () => {
    matchesSnapshot(
      'judge-ledger',
      judgePrompt({
        objective: 'Port the retry logic to the new client',
        criteria: withCriteria.criteria,
        ledger: LEDGER,
        evidence: '--- turn 1 — 1 tool call ---\n  1. Edit\n     args: src/client.js',
      }),
    );
  });

  it('continuation — a probe vetoed', () => {
    const verification = { source: 'probe', probeId: 'browser', ok: false, output: '  browser: 3 of 4 viewports clean; 375px overflows by 12px' };
    matchesSnapshot('continuation-probe-failed', continuationPrompt(withCriteria, { ...opts, verification }));
  });

  it('continuation — a prediction stopped holding', () => {
    const verification = {
      source: 'expect',
      ok: false,
      output: '  `grep -c retryLegacy src/client.js` says "0"\n    but: 3',
    };
    matchesSnapshot('continuation-expect-failed', continuationPrompt(withCriteria, { ...opts, verification }));
  });

  it('continuation — the work went outside its declared scope', () => {
    const verification = { source: 'scope', ok: false, output: '  billing/index.js\n  vendor/parser.js' };
    matchesSnapshot('continuation-scope-failed', continuationPrompt(withCriteria, { ...opts, verification }));
  });

  it('probe pending — holding the close while something is still measuring', () => {
    matchesSnapshot(
      'probe-pending',
      probePendingPrompt(withCriteria, {
        pending: [{ probeId: 'browser', startedAt: '2026-07-27T00:00:00.000Z', timeoutMs: 60000 }],
        defer: 1,
        maxDefers: 3,
        now: Date.parse('2026-07-27T00:00:34.000Z'),
      }),
    );
  });

  it('violation — a constraint has already been broken', () => {
    const goal = { ...withCriteria, constraints: ['do NOT touch the billing module'] };
    matchesSnapshot(
      'violation',
      violationPrompt(goal, { finding: 'src/billing/index.js was rewritten, which the objective excluded.' }),
    );
  });

  // The golden that matters for what it does not contain. `sealPrompt` is the one
  // place a held-out finding could reach the model, so this snapshot is also the
  // leak test: the assertions below pin that neither the command nor the output
  // is reachable from here, because neither is an argument.
  it('seal — a held-out check refused the close', () => {
    const rendered = sealPrompt(withCriteria, { showCommand: 'node /bandaid.js goal show --session S' });
    assert.doesNotMatch(rendered, /held-out cases|CANARY|exit 1/, 'the finding is the user\'s, not the model\'s');
    matchesSnapshot('seal', rendered);
  });

  it('seal — with nowhere to point the user', () => {
    matchesSnapshot('seal-bare', sealPrompt(withCriteria, {}));
  });

  it('judge — constraints and blockers change what it is asked to do', () => {
    matchesSnapshot(
      'judge-constraints',
      judgePrompt({
        objective: 'Port the retry logic to the new client without touching the billing module',
        criteria: withCriteria.criteria,
        constraints: ['do NOT touch the billing module'],
        blockers: ['confirming the retry timing needs a live upstream this session cannot reach'],
        evidence: '--- turn 1 — 1 tool call ---\n  1. Edit\n     args: src/client.js',
      }),
    );
  });

  it('budget limit', () => {
    matchesSnapshot('budget-limit', budgetLimitPrompt({ ...withCriteria, continuations: 8, tokenBudget: 50000, tokensUsed: 51200 }, opts));
  });

  // Not injected into the session — this one is spent in a separate process, once,
  // before any work happens. It gets a ceiling anyway: it is prose that reaches a
  // model on Bandaid's behalf, and the rule does not have an exemption for prose
  // that is spent somewhere cheaper.
  it('criteria — the rubric, written by something that will not be graded on it', () => {
    matchesSnapshot('criteria-derive', criteriaPrompt('Port the retry logic to the new client'));
  });

  it('judge — with and without a shared rubric', () => {
    matchesSnapshot(
      'judge-bare',
      judgePrompt({ objective: 'Port the retry logic to the new client', evidence: '--- turn 1 — 1 tool call ---\n  1. Edit\n     args: src/client.js' }),
    );
    matchesSnapshot(
      'judge-criteria',
      judgePrompt({
        objective: 'Port the retry logic to the new client',
        criteria: withCriteria.criteria,
        evidence: '--- turn 1 — 1 tool call ---\n  1. Edit\n     args: src/client.js',
        checkOutput: 'ok 12 passing',
      }),
    );
  });

  it('compaction instructions', () => {
    matchesSnapshot('compaction', [SUMMARIZATION_PROMPT, COMPACTION_FIDELITY_ADDENDUM].join('\n\n'));
  });

  it('restored context block', () => {
    const prompts = [
      { text: 'Port the retry logic to the new client', ts: '2026-07-26T10:00:00.000Z' },
      { text: "don't touch anything under vendor/", ts: '2026-07-26T10:04:00.000Z' },
      { text: 'also add a test for the timeout path', ts: '2026-07-26T10:11:00.000Z' },
    ];
    const batches = [
      {
        turnIndex: 1,
        calls: [
          { name: 'Bash', input: 'npm test', result: 'Error: 1 failing', failed: true },
          { name: 'Edit', input: 'src/client.js :: retryLegacy(', result: 'ok' },
        ],
      },
    ];
    matchesSnapshot(
      'restore-block',
      buildRestoreBlock({ prompts, batches, config: DEFAULTS, goal: { ...withCriteria, status: 'active' } }).text,
    );
  });
});

/**
 * A ceiling on every injected prompt, recorded rather than derived.
 *
 * `karpathy-report.md` names the failure this exists to prevent: "each addition
 * is individually plausible and none is ever measured, so nothing is ever
 * removed." A golden file makes a prompt edit *visible*; it does nothing to
 * make growth *expensive*. This does. Exceeding a ceiling fails the suite, so
 * lengthening a prompt means raising a number in a diff somebody reviews.
 *
 * These are not targets. Every one of them should be going down.
 */
// Retightened once the capacity line landed. Collapsing the four-line Budget block
// and the three-line Elapsed block into one line took **15 words off every one of
// the ten continuation goldens — 150 words** — while adding a wall-clock budget and
// an ETA, so every ceiling here came down rather than up. Each now sits 5 words
// above its golden, which is the smallest headroom that does not make an
// inconsequential rewording fail the suite.
const CEILINGS = {
  'budget-limit': 125,
  compaction: 257,
  // The autonomy paragraph is 57 words and appears only on the turn that asked
  // permission, so it costs nothing on any other path. This golden also carries the
  // block-command section, which is why it is not simply bare + 57.
  'continuation-asked-permission': 908,
  'continuation-bare': 783,
  'continuation-blocked': 936,
  'continuation-check-configured': 828,
  'continuation-check-failed': 893,
  'continuation-criteria': 788,
  'continuation-elapsed': 800,
  'continuation-elapsed-budgeted': 807,
  'continuation-evidence': 867,
  'continuation-expect-failed': 859,
  'continuation-judge-finding': 852,
  'continuation-probe-failed': 851,
  'continuation-scope-failed': 841,
  // Spent once per goal in a subprocess, not on any continuation, so its cost is
  // paid before the loop starts and never again.
  'criteria-derive': 192,
  'judge-bare': 190,
  'judge-constraints': 412,
  'judge-criteria': 238,
  'judge-ledger': 369,
  'open-objective-adopted': 207,
  'open-objective-offer': 257,
  'probe-pending': 91,
  'restore-block': 297,
  // Terminal, like `violation`: fires at most once per goal and never on the
  // continuation path, so its cost on an ordinary round is zero. Kept short for a
  // second reason — every sentence here is a sentence about a finding the model is
  // not being given, and there is not much to say about that honestly.
  seal: 137,
  'seal-bare': 119,
  violation: 196,
};

describe('the prompt surface does not quietly grow', () => {
  it('keeps every injected prompt under its recorded ceiling', () => {
    const over = [];
    for (const [name, ceiling] of Object.entries(CEILINGS)) {
      const file = path.join(DIR, `${name}.txt`);
      if (!fs.existsSync(file)) continue;
      const words = fs.readFileSync(file, 'utf8').split(/\s+/).filter(Boolean).length;
      if (words > ceiling) over.push(`${name}: ${words} words, ceiling ${ceiling}`);
    }
    assert.deepEqual(over, [], 'raising a ceiling is a deliberate line in a diff, not a side effect');
  });

  it('has a ceiling for every golden, so a new prompt cannot slip in unmeasured', () => {
    const missing = fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => f.replace(/\.txt$/, ''))
      .filter((name) => !(name in CEILINGS));
    assert.deepEqual(missing, [], 'add the new prompt to CEILINGS in test/prompts.snapshot.test.js');
  });
});
