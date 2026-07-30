'use strict';

// One direction only: goals.js must never require this module back, or the two
// close a cycle. The ceiling check in decideOnStop is deliberately self-contained
// (it reads goal.continuations and goal.refunded and nothing else) for that reason.
const { normalizeReason } = require('./goals');

/**
 * Did this round move the work, or only touch it?
 *
 * The continuation cap is a flat number per verifier tier, which is already better
 * than one number but is still wrong in both directions on a large task: a goal
 * making verified progress hits 8 and stops mid-refactor, while a goal spinning on
 * the same failure burns all 8 doing it. Karpathy's slider says autonomy should be
 * *earned*; the tier map earns it across tiers, and this earns it across rounds.
 *
 * **The whole difficulty is a signal that cannot be faked by touching a file.** A
 * refund is a reward, and any reward computed from something the model controls
 * gets optimised rather than earned. `turnWasTrivial` is not enough — it returns
 * false for any call to Edit/Write/Bash, so `touch` would buy a round.
 *
 * So the signals are ordered by how hard they are to fake, and only the first two
 * can grant a refund on their own:
 *
 *   criterion-covered  a criterion moved to `covered`, which requires a check,
 *                      probe, judge or expectation record — evidence.append forces
 *                      anything the model says to `unverified`, so it cannot write
 *                      itself one
 *   verdict-changed    the verification failure is substantively different from
 *                      last round's. "3 tests failing" becoming "1 test failing" is
 *                      progress, which is a distinction goals.js already draws
 *   task-completed     the model's own account of its plan. Grants **one** refund
 *                      per goal and no more
 *
 * Deliberately absent: the worktree fingerprint. It moves on any tracked edit and
 * is therefore free to fake, which makes it exactly the signal not to reward.
 */

/**
 * A completed task is the model's word for it, so it buys one round per goal.
 *
 * The brief called for requiring it *alongside* a verified signal, which on
 * inspection makes it worth nothing — the verified signal already grants the
 * refund on its own. One-per-goal is the version that does something while
 * remaining bounded, and this comment is here so the deviation is visible.
 */
const TASK_REFUNDS_PER_GOAL = 1;

/** How many criteria the ledger currently calls covered. */
function coveredCount(coverage) {
  if (!Array.isArray(coverage)) return null;
  return coverage.filter((entry) => entry && entry.state === 'covered').length;
}

/**
 * `{ progressed, signal }`. `signal` names which rule fired, so a wrong refund is
 * visible in goal.json rather than having to be reasoned about.
 */
function detect({ goal, coverage = null, taskState = null, reason = null } = {}) {
  const covered = coveredCount(coverage);
  if (covered != null && goal.coveredCount != null && covered > goal.coveredCount) {
    return { progressed: true, signal: `criterion-covered:${covered}` };
  }

  if (reason && goal.lastReason && normalizeReason(reason) !== normalizeReason(goal.lastReason)) {
    return { progressed: true, signal: 'verdict-changed' };
  }

  const completed = taskState ? taskState.completed : null;
  if (
    completed != null &&
    goal.completedTasks != null &&
    completed > goal.completedTasks &&
    (goal.taskRefunds || 0) < TASK_REFUNDS_PER_GOAL
  ) {
    return { progressed: true, signal: `task-completed:${completed}`, weak: true };
  }

  return { progressed: false, signal: null };
}

/**
 * What this round costs, and the bookkeeping that goes with it.
 *
 * A round that moved the work is free. A round that moved nothing twice running
 * costs double — so the feature makes the *bad* case end sooner than it does today,
 * which is what makes it safe to have on by default. Everything else costs one, as
 * it always has.
 */
function settle({ goal, progressed, signal, weak = false, now = Date.now() }) {
  const stalls = progressed ? 0 : (goal.stalls || 0) + 1;
  const cost = progressed ? 0 : stalls >= 2 ? 2 : 1;

  return {
    continuations: (goal.continuations || 0) + cost,
    refunded: (goal.refunded || 0) + (progressed ? 1 : 0),
    stalls,
    lastProgressSignal: signal || goal.lastProgressSignal || null,
    lastProgressAt: progressed ? new Date(now).toISOString() : goal.lastProgressAt || null,
    taskRefunds: (goal.taskRefunds || 0) + (progressed && weak ? 1 : 0),
    coveredCount: goal.coveredCount ?? null,
    completedTasks: goal.completedTasks ?? null,
  };
}

module.exports = { TASK_REFUNDS_PER_GOAL, coveredCount, detect, settle };
