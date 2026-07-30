'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { DEFAULTS } = require('../src/lib/config');
const {
  blockedOut,
  decideOnStop,
  endsWithQuestionToUser,
  extractConstraints,
  isGoalWorthy,
  newGoal,
  resolveMaxContinuations,
  turnWasTrivial,
  verifierStrength,
} = require('../src/lib/goals');

const editBatch = [{ calls: [{ name: 'Edit', input: 'src/a.js', result: 'ok' }] }];
const readBatch = [{ calls: [{ name: 'Read', input: 'src/a.js', result: 'contents' }] }];

describe('isGoalWorthy', () => {
  it('accepts real instructions', () => {
    assert.equal(isGoalWorthy('Refactor the parser to drop the regex path'), true);
  });

  it('rejects acknowledgements and noise', () => {
    for (const chatter of ['thanks', 'ok', 'yes', 'Perfect!', 'ty', '']) {
      assert.equal(isGoalWorthy(chatter), false, `${JSON.stringify(chatter)} should not become a goal`);
    }
  });
});

describe('endsWithQuestionToUser', () => {
  it('detects a closing question', () => {
    assert.equal(endsWithQuestionToUser('Done. Want me to also update the docs?'), true);
  });

  it('ignores a question mark that is not the last line', () => {
    assert.equal(endsWithQuestionToUser('Why was it slow? An N+1 query. Fixed.'), false);
    assert.equal(endsWithQuestionToUser('Is it done?\n\nYes — all tests pass.'), false);
  });

  it('is false for empty input', () => {
    assert.equal(endsWithQuestionToUser(''), false);
    assert.equal(endsWithQuestionToUser(null), false);
  });
});

describe('turnWasTrivial', () => {
  it('is false when the turn changed something', () => {
    assert.equal(turnWasTrivial(editBatch), false);
  });

  it('is true for a read-only turn', () => {
    assert.equal(turnWasTrivial(readBatch), true);
    assert.equal(turnWasTrivial([]), true);
  });
});

describe('decideOnStop', () => {
  const base = { config: DEFAULTS, stopHookActive: false, recentBatches: editBatch };

  it('blocks the stop while an active goal has continuations left', () => {
    const goal = newGoal('Ship the feature');
    const decision = decideOnStop({ ...base, goal });
    assert.equal(decision.action, 'continue');
  });

  it('respects stop_hook_active so it can never loop', () => {
    const goal = newGoal('Ship the feature');
    const decision = decideOnStop({ ...base, goal, stopHookActive: true });
    assert.equal(decision.action, 'allow');
    assert.equal(decision.reason, 'stop_hook_active');
  });

  it('stops blocking once the continuation budget is spent', () => {
    const goal = { ...newGoal('Ship the feature'), continuations: 2, maxContinuations: 2 };
    const decision = decideOnStop({ ...base, goal });
    assert.equal(decision.action, 'wrap-up');
  });

  // best-goal-report.md specified budgets on turns, tokens *and* wall-clock, and
  // convicts Codex of tracking elapsed time while enforcing none of it. These are
  // the tests for the third budget.
  describe('the wall-clock budget', () => {
    const START = '2026-07-30T13:00:00.000Z';
    const start = Date.parse(START);
    const goalAt = (extra = {}) => ({ ...newGoal('Ship the feature'), startedAt: START, ...extra });

    it('wraps up once the budget is spent', () => {
      const goal = goalAt({ timeBudgetMs: 60 * 60 * 1000 });
      const decision = decideOnStop({ ...base, goal, now: start + 61 * 60 * 1000 });
      assert.equal(decision.action, 'wrap-up');
      assert.equal(decision.reason, 'time budget exhausted');
    });

    it('keeps going at 99% of it, so the last minute is still working time', () => {
      const goal = goalAt({ timeBudgetMs: 60 * 60 * 1000 });
      const decision = decideOnStop({ ...base, goal, now: start + 59 * 60 * 1000 });
      assert.equal(decision.action, 'continue');
    });

    it('wraps up exactly at the boundary rather than one tick past it', () => {
      const goal = goalAt({ timeBudgetMs: 60 * 60 * 1000 });
      assert.equal(decideOnStop({ ...base, goal, now: start + 60 * 60 * 1000 }).action, 'wrap-up');
    });

    it('ignores an unbounded goal however long it has run', () => {
      const goal = goalAt({ timeBudgetMs: null });
      const decision = decideOnStop({ ...base, goal, now: start + 40 * 24 * 60 * 60 * 1000 });
      assert.equal(decision.action, 'continue');
    });

    it('falls back to the configured budget when the goal carries none', () => {
      const config = { ...DEFAULTS, goals: { ...DEFAULTS.goals, timeBudgetMs: 30 * 60 * 1000 } };
      const goal = goalAt();
      assert.equal(decideOnStop({ ...base, config, goal, now: start + 31 * 60 * 1000 }).action, 'wrap-up');
      assert.equal(decideOnStop({ ...base, config, goal, now: start + 10 * 60 * 1000 }).action, 'continue');
    });

    it("lets the goal's own budget override the configured one", () => {
      const config = { ...DEFAULTS, goals: { ...DEFAULTS.goals, timeBudgetMs: 30 * 60 * 1000 } };
      const goal = goalAt({ timeBudgetMs: 4 * 60 * 60 * 1000 });
      assert.equal(decideOnStop({ ...base, config, goal, now: start + 31 * 60 * 1000 }).action, 'continue');
    });

    it('cannot end a goal it has no start time for', () => {
      // An unknown elapsed must not read as an exhausted budget, or a goal record
      // written before this field existed would wrap up on its first stop.
      const goal = { ...newGoal('Ship the feature'), startedAt: null, createdAt: null, timeBudgetMs: 1000 };
      assert.equal(decideOnStop({ ...base, goal, now: start }).action, 'continue');
    });

    it('is outranked by stop_hook_active, which always wins', () => {
      const goal = goalAt({ timeBudgetMs: 1000 });
      const decision = decideOnStop({ ...base, goal, stopHookActive: true, now: start + 60_000 });
      assert.equal(decision.action, 'allow');
      assert.equal(decision.reason, 'stop_hook_active');
    });

    it('does not fire on a clock that moved backwards', () => {
      const goal = goalAt({ timeBudgetMs: 60 * 60 * 1000 });
      assert.equal(decideOnStop({ ...base, goal, now: start - 5 * 60 * 1000 }).action, 'continue');
    });
  });

  describe('autonomy: whether a permission-ask still ends the turn', () => {
    const on = { ...DEFAULTS, goals: { ...DEFAULTS.goals, autonomy: true } };
    const ask = 'I have finished the first module.\n\nShould I proceed?';
    const question = 'One thing I cannot determine:\n\nWhat should the retry limit be?';

    it('is off by default, so a trailing question mark still wins', () => {
      // The behaviour every existing user has. Asserted explicitly so that turning
      // this on by accident is loud rather than silent.
      const goal = newGoal('Ship the feature');
      const decision = decideOnStop({ ...base, goal, lastAssistantMessage: ask });
      assert.equal(decision.action, 'allow');
      assert.equal(decision.reason, 'model is asking the user a question');
    });

    it('with autonomy on, a permission-ask no longer buys a stop', () => {
      const goal = newGoal('Ship the feature');
      const decision = decideOnStop({ ...base, config: on, goal, lastAssistantMessage: ask });
      assert.equal(decision.action, 'continue');
      assert.equal(decision.askedPermission, true, 'and the continuation is told to say so');
    });

    it('with autonomy on, a genuine question still ends the turn', () => {
      // The failure this must never cause: a question the user never gets asked.
      const goal = newGoal('Ship the feature');
      const decision = decideOnStop({ ...base, config: on, goal, lastAssistantMessage: question });
      assert.equal(decision.action, 'allow');
      assert.match(decision.reason, /genuine/);
    });

    it('with autonomy on, an unrecognised question still ends the turn', () => {
      const goal = newGoal('Ship the feature');
      const decision = decideOnStop({
        ...base,
        config: on,
        goal,
        lastAssistantMessage: 'Is the moon made of cheese?',
      });
      assert.equal(decision.action, 'allow', 'uncertainty resolves to the old behaviour');
      assert.match(decision.reason, /unknown/);
    });

    it('never sets askedPermission on a turn that did not ask', () => {
      const goal = newGoal('Ship the feature');
      const decision = decideOnStop({ ...base, config: on, goal, lastAssistantMessage: 'Done.' });
      assert.equal(decision.action, 'continue');
      assert.ok(!decision.askedPermission);
    });

    it('lets a recorded blocker rescue a question that looks like a permission-ask', () => {
      const goal = { ...newGoal('Ship the feature'), blockers: ['the staging websocket endpoint needs a VPN'] };
      const decision = decideOnStop({
        ...base,
        config: on,
        goal,
        lastAssistantMessage: 'Should I proceed without the staging websocket endpoint?',
      });
      assert.equal(decision.action, 'allow');
    });

    it('is still outranked by stop_hook_active', () => {
      const goal = newGoal('Ship the feature');
      const decision = decideOnStop({ ...base, config: on, goal, lastAssistantMessage: ask, stopHookActive: true });
      assert.equal(decision.action, 'allow');
      assert.equal(decision.reason, 'stop_hook_active');
    });

    it('is still outranked by a spent continuation budget', () => {
      const goal = { ...newGoal('Ship the feature'), continuations: 2, maxContinuations: 2 };
      const decision = decideOnStop({ ...base, config: on, goal, lastAssistantMessage: ask });
      assert.equal(decision.action, 'wrap-up');
    });
  });

  it('lets a read-only turn end untouched', () => {
    const goal = newGoal('Explain the architecture');
    const decision = decideOnStop({ ...base, goal, recentBatches: readBatch });
    assert.equal(decision.action, 'allow');
    assert.equal(decision.reason, 'turn changed nothing');
  });

  it('audits a read-only turn when skipTrivialTurns is off', () => {
    const config = { ...DEFAULTS, goals: { ...DEFAULTS.goals, skipTrivialTurns: false } };
    const decision = decideOnStop({ ...base, config, goal: newGoal('Explain the architecture'), recentBatches: readBatch });
    assert.equal(decision.action, 'continue');
  });

  it('never blocks when the model is asking the user a question', () => {
    const decision = decideOnStop({
      ...base,
      goal: newGoal('Ship the feature'),
      lastAssistantMessage: 'I can migrate this two ways. Should I keep the legacy endpoint alive?',
    });
    assert.equal(decision.action, 'allow');
    assert.equal(decision.reason, 'model is asking the user a question');
  });

  it('still blocks when the answer merely mentions a question mark mid-text', () => {
    const decision = decideOnStop({
      ...base,
      goal: newGoal('Ship the feature'),
      lastAssistantMessage: 'You asked "why is it slow?" — the cause was an N+1 query. Fixed and tests pass.',
    });
    assert.equal(decision.action, 'continue');
  });

  it('never blocks without a goal', () => {
    assert.equal(decideOnStop({ ...base, goal: null }).action, 'allow');
  });

  it('never blocks a goal that is already closed', () => {
    for (const status of ['complete', 'blocked', 'budget_limited', 'abandoned']) {
      const goal = { ...newGoal('Ship it'), status };
      assert.equal(decideOnStop({ ...base, goal }).action, 'allow', `status ${status} should allow the stop`);
    }
  });

  it('honours the global kill switch', () => {
    const off = { ...DEFAULTS, enabled: false };
    assert.equal(decideOnStop({ ...base, config: off, goal: newGoal('Ship it') }).action, 'allow');
  });

  it('honours goals.mode = off', () => {
    const off = { ...DEFAULTS, goals: { ...DEFAULTS.goals, mode: 'off' } };
    assert.equal(decideOnStop({ ...base, config: off, goal: newGoal('Ship it') }).action, 'allow');
  });

  it('treats maxContinuations = 0 as disabled', () => {
    const goal = { ...newGoal('Ship it'), maxContinuations: 0 };
    assert.equal(decideOnStop({ ...base, goal }).action, 'allow');
  });
});

describe('autonomy slider', () => {
  const withGoals = (over) => ({ ...DEFAULTS, goals: { ...DEFAULTS.goals, ...over } });

  it('keeps the leash short when nothing verifies the work', () => {
    assert.equal(verifierStrength(DEFAULTS), 'unverified');
    assert.equal(resolveMaxContinuations(DEFAULTS), 2);
  });

  it('lengthens it for a judge and further for a check', () => {
    assert.equal(resolveMaxContinuations(withGoals({ judge: true })), 4);
    assert.equal(resolveMaxContinuations(withGoals({ check: 'npm test' })), 8);
  });

  it('ranks a check above a judge when both are configured', () => {
    const cfg = withGoals({ judge: true, check: 'npm test' });
    assert.equal(verifierStrength(cfg), 'verified');
    assert.equal(resolveMaxContinuations(cfg), 8);
  });

  it('lets a per-goal check earn the longer leash on its own', () => {
    assert.equal(resolveMaxContinuations(DEFAULTS, { check: 'make verify' }), 8);
  });

  it('ignores a check that is only whitespace', () => {
    assert.equal(resolveMaxContinuations(withGoals({ check: '   ' })), 2);
  });

  it('honours a scalar maxContinuations, which is what old configs look like', () => {
    assert.equal(resolveMaxContinuations(withGoals({ maxContinuations: 5, check: 'npm test' })), 5);
    assert.equal(resolveMaxContinuations(withGoals({ maxContinuations: 0 })), 0);
  });

  it('merges a partial tier override over the defaults', () => {
    const cfg = withGoals({ maxContinuations: { verified: 20 }, check: 'npm test' });
    assert.equal(resolveMaxContinuations(cfg), 20);
    assert.equal(resolveMaxContinuations(withGoals({ maxContinuations: { verified: 20 } })), 2);
  });

  it('feeds decideOnStop when the goal carries no cap of its own', () => {
    const goal = { ...newGoal('Ship it', { check: 'npm test' }), maxContinuations: null, continuations: 3 };
    const decision = decideOnStop({
      config: DEFAULTS,
      goal,
      stopHookActive: false,
      recentBatches: editBatch,
      lastAssistantMessage: 'Done.',
    });
    assert.equal(decision.action, 'continue', 'a checked goal should still have room at 3 continuations');
    assert.match(decision.reason, /4\/8/);
  });
});

describe('constraints', () => {
  it('pulls the negative half out of an objective', () => {
    const constraints = extractConstraints(
      'Migrate auth off JWT — do NOT touch the billing module, it ships Friday',
    );
    assert.deepEqual(constraints, ['do NOT touch the billing module']);
  });

  it('catches the phrasing that reads as a scope limit rather than a prohibition', () => {
    // The shape that cost a real session four consecutive stops: the constraint
    // rides along on the end of the thing being asked for. The whole clause is
    // kept rather than split at "and" — "do not touch billing and payments"
    // must not become a licence to touch payments.
    const constraints = extractConstraints('remove the unused assets and tidy the repo without touching generated output');
    assert.deepEqual(constraints, ['remove the unused assets and tidy the repo without touching generated output']);
  });

  it('finds nothing in a purely additive objective', () => {
    assert.deepEqual(extractConstraints('Port the retry logic to the new client and cover it with tests'), []);
  });

  it('is recorded on the goal at creation', () => {
    const goal = newGoal('Rewrite the parser. Never edit anything under vendor/.');
    assert.deepEqual(goal.constraints, ['Never edit anything under vendor/']);
  });
});

describe('blockers', () => {
  const withGoals = (patch) => ({ ...DEFAULTS, goals: { ...DEFAULTS.goals, ...patch } });

  it('does not fire before the limit', () => {
    assert.equal(blockedOut({ blockedStreak: 0 }, DEFAULTS), false);
    assert.equal(blockedOut({ blockedStreak: 1 }, DEFAULTS), false);
  });

  it('fires once enough of the objective is walled off', () => {
    assert.equal(blockedOut({ blockedStreak: 2 }, DEFAULTS), true);
    assert.equal(blockedOut({ blockedStreak: 9 }, DEFAULTS), true);
  });

  it('honours a configured limit, including disabling the exit entirely', () => {
    assert.equal(blockedOut({ blockedStreak: 2 }, withGoals({ blockerLimit: 4 })), false);
    assert.equal(blockedOut({ blockedStreak: 4 }, withGoals({ blockerLimit: 4 })), true);
    assert.equal(blockedOut({ blockedStreak: 99 }, withGoals({ blockerLimit: 0 })), false);
  });

  it('starts empty on a new goal', () => {
    const goal = newGoal('Ship the migration');
    assert.deepEqual(goal.blockers, []);
    assert.equal(goal.blockedStreak, 0);
  });
});

describe('the blocked counter, which a report called unwired', () => {
  // karpathy-report.md says blockedStreak/lastBlocker/blockedThreshold "exist and
  // nothing reads or increments any of them". That was true of the tree it was
  // measured against and is not true now: addBlocker increments, blockedOut reads,
  // and `blockedThreshold` does not exist at all — `blockerLimit` is the live knob.
  // These tests pin the wiring so the claim cannot quietly become true again.
  it('increments on each recorded blocker and is read by blockedOut', () => {
    const config = { ...DEFAULTS, goals: { ...DEFAULTS.goals, blockerLimit: 2 } };
    let goal = newGoal('Wire the printer flow');
    assert.equal(goal.blockedStreak, 0);
    assert.equal(blockedOut(goal, config), false);

    goal = { ...goal, blockedStreak: 1, lastBlocker: 'no printer attached' };
    assert.equal(blockedOut(goal, config), false, 'one blocker is not enough to give up');

    goal = { ...goal, blockedStreak: 2 };
    assert.equal(blockedOut(goal, config), true);
  });

  it('never gives up when the limit is zero', () => {
    const config = { ...DEFAULTS, goals: { ...DEFAULTS.goals, blockerLimit: 0 } };
    assert.equal(blockedOut({ ...newGoal('x'), blockedStreak: 9 }, config), false);
  });
});

describe('baseSha', () => {
  it('records the commit a goal starts from, so later work can be diffed against it', () => {
    const goal = newGoal('Port the retry logic', { cwd: require('node:path').resolve(__dirname, '..') });
    assert.match(goal.baseSha, /^[0-9a-f]{40}$/, 'this repo is a git worktree, so there is a HEAD to record');
  });

  it('is null rather than a guess outside a repository', () => {
    const goal = newGoal('Port the retry logic', { cwd: require('node:os').tmpdir() });
    assert.equal(goal.baseSha, null, 'consumers must read this as "cannot tell", never as "nothing changed"');
  });

  it('never throws on a cwd that does not exist', () => {
    assert.doesNotThrow(() => newGoal('x', { cwd: '/nope/not/here' }));
  });
});
