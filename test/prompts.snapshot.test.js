'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const { DEFAULTS } = require('../src/lib/config');
const { newGoal } = require('../src/lib/goals');
const { buildRestoreBlock } = require('../src/lib/restore');
const { judgePrompt } = require('../src/lib/verify');
const {
  COMPACTION_FIDELITY_ADDENDUM,
  SUMMARIZATION_PROMPT,
  budgetLimitPrompt,
  continuationPrompt,
  openObjectivePrompt,
  probePendingPrompt,
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
};
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
const CEILINGS = {
  'budget-limit': 130,
  compaction: 260,
  'continuation-bare': 800,
  'continuation-blocked': 960,
  'continuation-check-configured': 850,
  'continuation-check-failed': 910,
  'continuation-criteria': 810,
  'continuation-evidence': 890,
  'continuation-expect-failed': 880,
  'continuation-judge-finding': 870,
  'continuation-probe-failed': 870,
  'continuation-scope-failed': 860,
  'judge-bare': 195,
  'judge-constraints': 420,
  'judge-criteria': 245,
  'judge-ledger': 375,
  'open-objective-adopted': 215,
  'open-objective-offer': 265,
  'probe-pending': 95,
  'restore-block': 300,
  violation: 200,
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
