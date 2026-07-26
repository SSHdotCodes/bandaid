'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { DEFAULTS } = require('../src/lib/config');
const { newGoal, plateauReached, recordReason } = require('../src/lib/goals');
const { assess, evidenceFromTurns, parseVerdict, runCheck } = require('../src/lib/verify');

const withGoals = (patch) => ({ ...DEFAULTS, goals: { ...DEFAULTS.goals, ...patch } });

describe('runCheck', () => {
  it('reports a passing command', () => {
    const result = runCheck('exit 0');
    assert.equal(result.ok, true);
    assert.equal(result.status, 0);
  });

  it('reports a failing command with its output', () => {
    const result = runCheck('echo "2 tests failed" >&2; exit 1');
    assert.equal(result.ok, false);
    assert.match(result.output, /2 tests failed/);
  });

  it('is null when no check is configured', () => {
    assert.equal(runCheck(null), null);
    assert.equal(runCheck('   '), null);
  });

  it('treats a command that cannot run as unproven, not as proof', () => {
    const result = runCheck('definitely-not-a-real-command-xyz');
    assert.equal(result.ok, false, 'silence must never be evidence of completion');
  });

  it('treats a hanging command as unproven rather than hanging the session', () => {
    const result = runCheck('sleep 30', { timeoutMs: 250 });
    assert.equal(result.ok, false);
  });
});

describe('parseVerdict', () => {
  it('reads the two-line contract', () => {
    const parsed = parseVerdict('VERDICT: continue\nREASON: the migration misses src/legacy.ts');
    assert.equal(parsed.verdict, 'continue');
    assert.equal(parsed.reason, 'the migration misses src/legacy.ts');
  });

  it('tolerates surrounding chatter', () => {
    const parsed = parseVerdict('I checked the files.\n\nVERDICT: complete\nREASON: all four endpoints exist\n');
    assert.equal(parsed.verdict, 'complete');
  });

  it('returns no opinion when the contract is not followed', () => {
    assert.equal(parseVerdict('looks good to me'), null);
    assert.equal(parseVerdict(''), null);
  });
});

describe('assess', () => {
  const goal = newGoal('Migrate auth off JWT');

  it('does exactly nothing when neither tier is configured', () => {
    const result = assess({ goal, config: DEFAULTS, turns: [] });
    assert.equal(result.proven, false);
    assert.equal(result.verification, null, 'unconfigured must mean the original behaviour, untouched');
  });

  it('closes the goal when the check passes', () => {
    const result = assess({ goal, config: withGoals({ check: 'exit 0' }), turns: [] });
    assert.equal(result.proven, true);
    assert.equal(result.verification.source, 'check');
  });

  it('vetoes the stop when the check fails, and says why', () => {
    const result = assess({ goal, config: withGoals({ check: 'echo boom; exit 3' }), turns: [] });
    assert.equal(result.proven, false);
    assert.match(result.verification.output, /boom/);
  });

  it('prefers the goal\'s own check over the global one', () => {
    const result = assess({
      goal: { ...goal, check: 'exit 1' },
      config: withGoals({ check: 'exit 0' }),
      turns: [],
    });
    assert.equal(result.proven, false, 'the per-goal command is the specific one and wins');
  });

  it('never consults the judge once ground truth has said no', () => {
    let judged = false;
    const result = assess({
      goal,
      config: withGoals({ check: 'exit 1', judge: true }),
      turns: [],
      spawn: {
        runJudge: () => {
          judged = true;
          return { verdict: 'complete', reason: 'looks fine' };
        },
      },
    });
    assert.equal(judged, false, 'a non-zero exit is not a matter of opinion');
    assert.equal(result.proven, false);
  });

  it('lets the judge close a goal that has no check', () => {
    const result = assess({
      goal,
      config: withGoals({ judge: true }),
      turns: [],
      spawn: { runJudge: () => ({ verdict: 'complete', reason: 'every endpoint migrated' }) },
    });
    assert.equal(result.proven, true);
    assert.equal(result.verification.source, 'judge');
  });

  it('lets the judge overrule a passing check on intent', () => {
    const result = assess({
      goal,
      config: withGoals({ check: 'exit 0', judge: true }),
      turns: [],
      spawn: { runJudge: () => ({ verdict: 'continue', reason: 'tests pass but src/legacy.ts still signs JWTs' }) },
    });
    assert.equal(result.proven, false, 'green tests are not the same as the objective being met');
    assert.match(result.verification.output, /legacy/);
  });

  it('falls back to the check when the judge cannot run', () => {
    const result = assess({
      goal,
      config: withGoals({ check: 'exit 0', judge: true }),
      turns: [],
      spawn: { runJudge: () => null },
    });
    assert.equal(result.proven, true, 'a missing judge abstains; it does not veto');
  });
});

describe('evidenceFromTurns', () => {
  it('renders the tool record the judge is asked to check', () => {
    const evidence = evidenceFromTurns([
      { turnIndex: 1, calls: [{ name: 'Bash', input: 'npm test', result: '1 failing' }] },
    ]);
    assert.match(evidence, /npm test/);
    assert.match(evidence, /1 failing/);
  });

  it('is empty when nothing has run', () => {
    assert.equal(evidenceFromTurns([]), '');
  });
});

describe('continuationPrompt', () => {
  const { continuationPrompt } = require('../src/lib/prompts');
  const opts = { completeCommand: 'bandaid goal complete' };

  it('counts the first continuation as the first, not the last', () => {
    const goal = { ...newGoal('Ship it'), continuations: 1, maxContinuations: 2 };
    assert.match(continuationPrompt(goal, opts), /Continuation: 1 of 2/);
  });

  it('puts a failed check above the audit and marks it external', () => {
    const goal = { ...newGoal('Ship it'), continuations: 1 };
    const text = continuationPrompt(goal, {
      ...opts,
      verification: { source: 'check', command: 'npm test', ok: false, output: 'FAIL auth.test.ts:41' },
    });
    assert.match(text, /not up for debate/);
    assert.match(text, /FAIL auth\.test\.ts:41/);
    assert.ok(text.indexOf('FAIL auth.test.ts:41') < text.indexOf('Completion audit'), 'the external verdict leads');
  });

  it('says nothing about verification when there was none', () => {
    const text = continuationPrompt({ ...newGoal('Ship it'), continuations: 1 }, opts);
    assert.doesNotMatch(text, /Verification result/);
  });
});

describe('plateau detection', () => {
  it('counts identical failures and ignores changing ones', () => {
    let goal = newGoal('Fix the suite');
    goal = recordReason(goal, 'check failed: npm test');
    assert.equal(goal.plateau, 0, 'the first failure is just a failure');

    goal = recordReason(goal, 'check failed: npm test');
    assert.equal(goal.plateau, 1);

    goal = recordReason(goal, 'check failed: npm run lint');
    assert.equal(goal.plateau, 0, 'a different failure means the loop is still moving');
  });

  it('gives up once the same failure repeats past the limit', () => {
    const config = withGoals({ plateauLimit: 2 });
    let goal = newGoal('Fix the suite');
    for (let i = 0; i < 3; i += 1) goal = recordReason(goal, 'check failed: npm test');
    assert.equal(plateauReached(goal, config), true);
  });

  it('does not trip on an unverified goal', () => {
    const goal = recordReason(newGoal('Ship it'), null);
    assert.equal(plateauReached(goal, DEFAULTS), false, 'no verification means no plateau signal');
  });
});
