'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { DEFAULTS } = require('../src/lib/config');
const { newGoal, plateauReached, recordReason } = require('../src/lib/goals');
const { assess, evidenceFromTurns, judgePrompt, parseVerdict, runCheck } = require('../src/lib/verify');

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
    assert.match(continuationPrompt(goal, opts), /continuation 1\/2/);
  });

  it('says nothing about a budget nobody set', () => {
    // Three of the four lines this replaced said "none" or "unbounded" on the
    // default configuration. Absent is cheaper and clearer than unbounded.
    const goal = { ...newGoal('Ship it'), continuations: 1, maxContinuations: 2, startedAt: null, createdAt: null };
    const text = continuationPrompt(goal, opts);
    assert.doesNotMatch(text, /tokens/i);
    assert.doesNotMatch(text, /unbounded/);
    assert.match(text, /^Capacity: continuation 1\/2$/m);
  });

  it('tells the model when the leash was lengthened, and only then', () => {
    // Three words, and they say the loop is being extended because the work is
    // moving — information about its own situation nothing else conveys.
    const earned = { ...newGoal('Ship it'), continuations: 3, maxContinuations: 8, refunded: 2 };
    assert.match(continuationPrompt(earned, opts), /continuation 3\/8 \(2 earned\)/);

    const none = { ...newGoal('Ship it'), continuations: 3, maxContinuations: 8, refunded: 0 };
    assert.match(continuationPrompt(none, opts), /continuation 3\/8(?! \()/);
  });

  it('marks the estimate as one and leaves the measured figures unmarked', () => {
    const goal = { ...newGoal('Ship it'), continuations: 2, maxContinuations: 4, tokenBudget: 50_000, tokensUsed: 12_000 };
    const text = continuationPrompt(goal, {
      ...opts,
      eta: { remainingMs: 35 * 60_000, lowMs: 20 * 60_000, highMs: 70 * 60_000, basis: 'tasks', unitsRemaining: 7 },
    });
    assert.match(text, /~35m left \(7 tasks, 20m–1h 10m\)/);
    assert.match(text, /~12000 of 50000 tokens/, 'the token figure is a floor, so it is marked too');
    assert.match(text, /continuation 2\/4/, 'a counted figure carries no tilde');
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

describe('violated verdict', () => {
  it('is accepted by the two-line contract', () => {
    const parsed = parseVerdict('VERDICT: violated\nREASON: vendor/ was deleted, which the objective said to leave alone');
    assert.equal(parsed.verdict, 'violated');
    assert.match(parsed.reason, /vendor\//);
  });

  it('surfaces through assess as neither proven nor merely unfinished', () => {
    const goal = { ...newGoal('Tidy the repo without touching vendor/'), criteria: [] };
    const result = assess({
      goal,
      config: withGoals({ judge: true }),
      turns: [],
      spawn: {
        runJudge: () => ({ verdict: 'violated', reason: 'vendor/ has been deleted' }),
      },
    });
    assert.equal(result.proven, false);
    assert.equal(result.violated, true, 'a broken constraint must not be handed back as ordinary unfinished work');
    assert.match(result.reason, /vendor\//);
  });

  it('leaves an ordinary continue untouched', () => {
    const result = assess({
      goal: newGoal('Ship the migration'),
      config: withGoals({ judge: true }),
      turns: [],
      spawn: { runJudge: () => ({ verdict: 'continue', reason: 'src/legacy.ts is unmigrated' }) },
    });
    assert.equal(result.violated, false);
  });
});

describe('judgePrompt', () => {
  it('hands the judge the constraints as vetoes and the blockers as settled', () => {
    const prompt = judgePrompt({
      objective: 'Tidy the repo',
      evidence: '',
      checkOutput: null,
      constraints: ['do not touch vendor/'],
      blockers: ['confirming the fix needs a GPU this machine does not have'],
    });
    assert.match(prompt, /do not touch vendor\//);
    assert.match(prompt, /needs a GPU this machine does not have/);
    assert.match(prompt, /Use "violated"/, 'the third verdict is only offered when there is something to violate');
    assert.match(prompt, /Do not count these against completion/);
  });

  it('does not offer the violated verdict when the objective has no constraints', () => {
    const prompt = judgePrompt({ objective: 'Ship it', evidence: '', checkOutput: null });
    assert.doesNotMatch(prompt, /Use "violated"/);
  });
});

describe('blockersSection', () => {
  const { blockersSection } = require('../src/lib/prompts');

  it('renders nothing when nothing is blocked', () => {
    assert.equal(blockersSection(newGoal('x')), '');
  });

  it('states the blockers as settled, not as remaining work', () => {
    const text = blockersSection({ blockers: ['the printer is not attached'], blockedStreak: 1 });
    assert.match(text, /do not re-argue them/);
    assert.match(text, /the printer is not attached/);
  });

  it('says so when the same wall has been reported twice', () => {
    // blockedStreak counts reports; blockers holds the distinct ones, so a gap
    // between them is the loop circling one thing rather than spreading out.
    const text = blockersSection({
      blockers: ['the printer is not attached'],
      blockedStreak: 2,
      lastBlocker: 'the printer is not attached',
    });
    assert.match(text, /more than once/);
    assert.match(text, /Work something else/);
  });

  it('stays quiet when two different things are blocked', () => {
    const text = blockersSection({
      blockers: ['no printer', 'no GPU'],
      blockedStreak: 2,
      lastBlocker: 'no GPU',
    });
    assert.doesNotMatch(text, /more than once/);
  });
});
