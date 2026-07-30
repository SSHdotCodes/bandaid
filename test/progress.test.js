'use strict';

/**
 * The earned leash.
 *
 * A refund is a reward, so the failure this exists to catch is a reward the model
 * can pay itself. The important tests here are the *negative* ones: editing a file
 * must not buy a round, a worktree fingerprint must not, and a task list the model
 * writes itself must not buy more than one.
 *
 * The other thing under test is that the worst case stays finite. A refunded round
 * costs nothing, so without a ceiling this becomes an unbounded loop — which is the
 * failure at the other end, and the one best-goal-report.md convicts Codex of.
 */

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const progress = require('../src/lib/progress');
const { CEILING_MULTIPLIER, DEFAULTS, decideOnStop, newGoal } = (() => ({
  ...require('../src/lib/goals'),
  DEFAULTS: require('../src/lib/config').DEFAULTS,
}))();

const covered = (n, total) =>
  Array.from({ length: total }, (_, i) => ({ criterion: i + 1, state: i < n ? 'covered' : 'uncovered' }));
const claimed = (n, total) =>
  Array.from({ length: total }, (_, i) => ({ criterion: i + 1, state: i < n ? 'claimed-only' : 'uncovered' }));
const tasks = (completed, total) => ({ completed, total, durations: [], fuzzyDurations: 0 });

describe('detect', () => {
  it('counts a criterion reaching covered — the hardest signal to fake', () => {
    const goal = { ...newGoal('x'), coveredCount: 1 };
    const result = progress.detect({ goal, coverage: covered(2, 4) });
    assert.equal(result.progressed, true);
    assert.match(result.signal, /^criterion-covered:2$/);
  });

  it('does not count a criterion the model merely asserted', () => {
    // claimed-only is the model's word for it. evidence.append forces anything the
    // model supplies to `unverified`, and this is the other half of that rule.
    const goal = { ...newGoal('x'), coveredCount: 0 };
    assert.equal(progress.detect({ goal, coverage: claimed(3, 4) }).progressed, false);
  });

  it('counts a verification failure that changed in substance', () => {
    const goal = { ...newGoal('x'), lastReason: 'check failed: 3 tests failing' };
    const result = progress.detect({ goal, reason: 'check failed: 1 test failing' });
    assert.equal(result.progressed, true);
    assert.equal(result.signal, 'verdict-changed');
  });

  it('does not count the same failure restated', () => {
    const goal = { ...newGoal('x'), lastReason: 'check failed: 3 tests failing' };
    assert.equal(progress.detect({ goal, reason: 'CHECK FAILED:   3 tests failing' }).progressed, false);
  });

  it('lets a completed task buy exactly one round, ever', () => {
    const goal = { ...newGoal('x'), completedTasks: 1, taskRefunds: 0 };
    const first = progress.detect({ goal, taskState: tasks(2, 8) });
    assert.equal(first.progressed, true);
    assert.equal(first.weak, true, 'and it is marked as the model\'s own account');

    const spent = { ...goal, taskRefunds: progress.TASK_REFUNDS_PER_GOAL };
    assert.equal(progress.detect({ goal: spent, taskState: tasks(3, 8) }).progressed, false);
  });

  it('ignores a worktree that merely moved, which is free to fake', () => {
    // There is deliberately no path from a changed fingerprint to a refund. This
    // asserts the absence: nothing but the three signals grants one.
    const goal = { ...newGoal('x'), coveredCount: 2, completedTasks: 3, lastReason: 'check failed: 3 tests failing' };
    const result = progress.detect({
      goal,
      coverage: covered(2, 4),
      taskState: tasks(3, 8),
      reason: 'check failed: 3 tests failing',
    });
    assert.equal(result.progressed, false, 'an edit that achieved nothing is not progress');
  });

  it('says nothing happened when it has nothing to compare against', () => {
    const goal = newGoal('x');
    assert.equal(progress.detect({ goal }).progressed, false);
    assert.equal(progress.detect({ goal, coverage: covered(2, 4) }).progressed, false, 'no prior snapshot');
  });
});

describe('settle', () => {
  const goal = { ...newGoal('x'), continuations: 3 };

  it('makes a round that moved the work free', () => {
    const next = progress.settle({ goal, progressed: true, signal: 'criterion-covered:2' });
    assert.equal(next.continuations, 3, 'not spent');
    assert.equal(next.refunded, 1);
    assert.equal(next.stalls, 0);
    assert.equal(next.lastProgressSignal, 'criterion-covered:2');
    assert.ok(next.lastProgressAt);
  });

  it('charges one for a round that did nothing, as it always has', () => {
    const next = progress.settle({ goal, progressed: false });
    assert.equal(next.continuations, 4);
    assert.equal(next.stalls, 1);
  });

  it('charges double once nothing has happened twice running', () => {
    // The feature makes the bad case end sooner than it does today. That is what
    // makes it safe to have on by default.
    const stalling = { ...goal, stalls: 1 };
    const next = progress.settle({ goal: stalling, progressed: false });
    assert.equal(next.continuations, 5);
    assert.equal(next.stalls, 2);
  });

  it('resets the stall counter the moment the work moves again', () => {
    const stalling = { ...goal, stalls: 2 };
    assert.equal(progress.settle({ goal: stalling, progressed: true }).stalls, 0);
  });

  it('only spends a task refund when a task was what earned it', () => {
    assert.equal(progress.settle({ goal, progressed: true, weak: true }).taskRefunds, 1);
    assert.equal(progress.settle({ goal, progressed: true, weak: false }).taskRefunds, 0);
  });
});

describe('the ceiling', () => {
  const base = {
    config: DEFAULTS,
    stopHookActive: false,
    recentBatches: [{ calls: [{ name: 'Edit' }] }],
  };

  it('keeps the worst case finite however many refunds were earned', () => {
    // This is the loop-safety test, and it is the important one in this file.
    const max = 4;
    const goal = { ...newGoal('Ship it'), maxContinuations: max, continuations: 0, refunded: max * CEILING_MULTIPLIER };
    const decision = decideOnStop({ ...base, goal });
    assert.equal(decision.action, 'wrap-up');
    assert.match(decision.reason, /round ceiling/);
  });

  it('still allows a goal below the ceiling to keep going', () => {
    const goal = { ...newGoal('Ship it'), maxContinuations: 4, continuations: 2, refunded: 3 };
    assert.equal(decideOnStop({ ...base, goal }).action, 'continue');
  });

  it('counts spent and refunded rounds together, not separately', () => {
    const max = 2;
    const goal = { ...newGoal('Ship it'), maxContinuations: max, continuations: 1, refunded: 5 };
    // 1 + 5 = 6 = 2 x 3, so this is the ceiling exactly.
    assert.equal(decideOnStop({ ...base, goal }).action, 'wrap-up');
  });

  it('respects a scalar maxContinuations somebody chose on purpose', () => {
    // Whoever set maxContinuations: 1 meant it; the ceiling scales from their
    // number rather than overriding it.
    const config = { ...DEFAULTS, goals: { ...DEFAULTS.goals, maxContinuations: 1 } };
    const goal = { ...newGoal('Ship it'), maxContinuations: 1, continuations: 1, refunded: 2 };
    assert.equal(decideOnStop({ ...base, config, goal }).action, 'wrap-up');
  });

  it('is still outranked by an exhausted wall-clock budget', () => {
    const start = Date.parse('2026-07-30T10:00:00.000Z');
    const goal = {
      ...newGoal('Ship it'),
      maxContinuations: 8,
      continuations: 0,
      refunded: 0,
      startedAt: '2026-07-30T10:00:00.000Z',
      timeBudgetMs: 60_000,
    };
    const decision = decideOnStop({ ...base, goal, now: start + 120_000 });
    assert.equal(decision.action, 'wrap-up');
    assert.equal(decision.reason, 'time budget exhausted');
  });
});
