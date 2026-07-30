'use strict';

const { timeUsedMs } = require('./duration');

/**
 * How much longer this is likely to take.
 *
 * The rule this module is written under: **an ETA without an error bar is a guess
 * wearing a number**, and a bare figure gets acted on. So every estimate carries
 * the observed spread it came from, says which basis produced it, and how many
 * observations that was — and when there is not enough to say anything, it says
 * nothing rather than widening a range until it is meaningless.
 *
 * Two bases, in preference order, and the second is not really a fallback:
 *
 *   tasks          median duration of completed tasks x tasks remaining. This is
 *                  what an "ETA from task counts" means, and it is exact input:
 *                  a task's duration is a subtraction between two stamped events.
 *                  It is also **absent most of the time** — measured across 15
 *                  local sessions, 1 had a task list at all.
 *   continuations   mean interval between continuations x rounds remaining, where
 *                  rounds remaining comes from criteria coverage. Coarser, and
 *                  available on any goal that has been round the loop twice.
 *
 * Neither is calibrated yet. See eval/eta-backtest.js, which is what decides
 * whether either beats the dumbest thing that could work.
 */

/** Below this, there is nothing to estimate from and no estimate is offered. */
const MIN_OBSERVATIONS = 3;

/**
 * Plain median. A mean is wrong here — one task that took two hours should not
 * double the estimate for four that took ten minutes.
 *
 * It was a *trimmed* median until the backtest was run. Trimming the extremes
 * sounded better and measured worse: on the only scoreable session, trimmed
 * scored 24% MAPE against the plain median's 22%, with identical within-2x. Two
 * points on ten paired points from one synthetic fixture is not a real
 * difference — but "not a real difference" is not a reason to keep the more
 * complicated one, so the trimming is gone. See eval/eta-backtest.js.
 */
function median(values) {
  const sorted = values.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Nearest-rank quantile, so every bound reported was actually observed. */
function quantile(values, q) {
  const sorted = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/**
 * An interquartile range, deliberately not a confidence interval.
 *
 * A confidence interval implies a distributional assumption this data has not
 * earned: durations are long-tailed and n is routinely under twenty.
 */
function spread(values, units) {
  const low = quantile(values, 0.25);
  const high = quantile(values, 0.75);
  if (low == null || high == null) return { lowMs: null, highMs: null };
  return { lowMs: low * units, highMs: high * units };
}

/**
 * The intervals between recorded continuations. n timestamps give n-1 intervals,
 * which is why a goal needs several rounds before this basis says anything.
 */
function continuationIntervals(goal) {
  const trail = Array.isArray(goal.continuationAt) ? goal.continuationAt : [];
  const stamps = trail.map((iso) => Date.parse(iso)).filter((n) => Number.isFinite(n));
  const out = [];
  for (let i = 1; i < stamps.length; i += 1) out.push(Math.max(0, stamps[i] - stamps[i - 1]));
  return out;
}

/**
 * Rounds still to come, from how much of the bar is already met.
 *
 * If two of five criteria are covered after four rounds, the whole objective
 * projects to ten rounds and six remain. It is crude, it assumes the remaining
 * criteria cost what the finished ones did, and with nothing covered it declines
 * to guess rather than assuming the work has barely started.
 */
function roundsRemaining(goal, coverageStates) {
  // The array evidence.coverage returns: one { criterion, state } per criterion.
  // Only `covered` counts — a `claimed-only` criterion is the model's word for it,
  // and treating an assertion as progress is what the whole ledger exists to avoid.
  if (!Array.isArray(coverageStates) || !coverageStates.length) return null;
  const total = coverageStates.length;
  const done = coverageStates.filter((entry) => entry && entry.state === 'covered').length;
  if (!done) return null;
  if (done >= total) return 0;

  const rounds = Math.max(1, goal.continuations || 0);
  const projected = rounds * (total / done);
  return Math.max(0, Math.ceil(projected - rounds));
}

/**
 * Estimate the wall-clock remaining, or null.
 *
 * `taskState` is src/lib/tasks.js's `state()`; `coverage` is the shape
 * src/lib/evidence.js reports. Both optional — what is available decides the
 * basis, and nothing available means no estimate.
 */
function estimate(goal, { taskState = null, coverage = null, now = Date.now() } = {}) {
  if (!goal) return null;

  // Basis 1: observed task durations. What "an ETA from task counts" means.
  if (taskState && taskState.durations.length >= MIN_OBSERVATIONS) {
    const remainingTasks = taskState.total - taskState.completed;
    if (remainingTasks > 0) {
      const per = median(taskState.durations);
      if (per != null) {
        return {
          remainingMs: per * remainingTasks,
          ...spread(taskState.durations, remainingTasks),
          basis: 'tasks',
          n: taskState.durations.length,
          unitsRemaining: remainingTasks,
          // Durations resting on a guessed match are counted separately so a
          // consumer can discount an estimate built partly on inference.
          fuzzy: taskState.fuzzyDurations || 0,
        };
      }
    }
  }

  // Basis 2: how long a round has been taking, times the rounds the bar implies.
  const intervals = continuationIntervals(goal);
  if (intervals.length >= MIN_OBSERVATIONS - 1) {
    const rounds = roundsRemaining(goal, coverage);
    if (rounds != null && rounds > 0) {
      const per = median(intervals);
      if (per != null) {
        return {
          remainingMs: per * rounds,
          ...spread(intervals, rounds),
          basis: 'continuations',
          n: intervals.length,
          unitsRemaining: rounds,
          fuzzy: 0,
        };
      }
    }
  }

  return null;
}

/**
 * The baseline the estimator has to beat: median duration x units remaining, with
 * no spread, no basis selection, and no floor — it will answer from one sample.
 *
 * It exists so that "the estimator works" is a comparison rather than an
 * assertion, and it won on the point estimate, which is why the estimator's point
 * estimate is now the same arithmetic. What remains different is deliberate and
 * unmeasured: the observation floor, the interquartile range, and the
 * continuation basis for the 93% of sessions with no task list at all.
 */
function baseline(goal, { taskState = null } = {}) {
  if (!taskState || !taskState.durations.length) return null;
  const remainingTasks = taskState.total - taskState.completed;
  if (remainingTasks <= 0) return null;
  const sorted = [...taskState.durations].sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)];
  return { remainingMs: middle * remainingTasks, basis: 'baseline', n: sorted.length };
}

/**
 * One clause, or ''. Rendered only where something already spends tokens.
 *
 * The `~` and the range are not decoration: this number sits beside a measured
 * elapsed and a counted continuation, and rendering all three with equal
 * confidence is how a useful signal becomes a misleading one.
 */
function render(est, { formatDuration }) {
  if (!est || est.remainingMs == null) return '';
  const point = formatDuration(est.remainingMs);
  if (!point) return '';

  const low = est.lowMs == null ? null : formatDuration(est.lowMs);
  const high = est.highMs == null ? null : formatDuration(est.highMs);
  const range = low && high && low !== high ? `, range ${low}–${high}` : '';

  const unit = est.basis === 'tasks' ? 'task' : 'round';
  const plural = est.unitsRemaining === 1 ? '' : 's';
  return `~${point} remaining (${est.unitsRemaining} ${unit}${plural} left${range})`;
}

module.exports = {
  MIN_OBSERVATIONS,
  baseline,
  continuationIntervals,
  estimate,
  quantile,
  render,
  roundsRemaining,
  timeUsedMs,
  median,
};
