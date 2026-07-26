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
const base = { ...newGoal('Port the retry logic to the new client', { maxContinuations: 2 }), continuations: 1 };
const withCriteria = {
  ...base,
  criteria: ['npm test exits 0', 'src/client.js no longer references retryLegacy', 'the backoff delays actually grow'],
  criteriaSource: 'model',
};
const opts = { completeCommand: 'node /bandaid.js goal complete --session S', criteriaCommand: 'node /bandaid.js goal criteria --session S "first" "second"' };

describe('prompt snapshots', () => {
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
