'use strict';

/**
 * The estimator.
 *
 * The failure this exists to catch is a number nobody checked. An ETA is acted
 * on, so the tests here are less about arithmetic than about refusal: too few
 * observations must produce *nothing* rather than a wide range, an assertion must
 * not count as progress, and an estimator that can see the future scores
 * perfectly and means nothing.
 */

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const eta = require('../src/lib/eta');
const { formatDuration } = require('../src/lib/duration');

const MINUTE = 60_000;

const taskState = (durations, { total, completed, fuzzyDurations = 0 }) => ({
  total,
  completed,
  inProgress: 0,
  pending: total - completed,
  dropped: 0,
  durations,
  fuzzyDurations,
  tasks: [],
});

describe('median', () => {
  it('is not moved by one long outlier, which is why it is not a mean', () => {
    const value = eta.median([10 * MINUTE, 10 * MINUTE, 11 * MINUTE, 12 * MINUTE, 120 * MINUTE]);
    assert.equal(value, 11 * MINUTE);
    const mean = (10 + 10 + 11 + 12 + 120) / 5;
    assert.ok(mean > 30, 'the mean really is that bad — that is the point');
  });

  it('averages the two middles on an even count', () => {
    assert.equal(eta.median([10, 20, 30, 40]), 25);
  });

  it('is a plain median, not a trimmed one — the backtest said trimming did not pay', () => {
    // Trimming would drop the 1 and the 100 and return 3. It measured worse on the
    // only scoreable session, so the simpler arithmetic is what ships.
    assert.equal(eta.median([1, 2, 3, 4, 100]), 3);
    assert.equal(eta.median([1, 2, 3, 4, 5, 6]), 4);
  });

  it('has nothing to say about nothing', () => {
    assert.equal(eta.median([]), null);
    assert.equal(eta.median([null, undefined, NaN, -1]), null);
  });
});

describe('estimate — the task basis', () => {
  const goal = { continuations: 2, continuationAt: [] };

  it('projects remaining tasks at the observed rate, with the observed spread', () => {
    const state = taskState([10 * MINUTE, 12 * MINUTE, 23 * MINUTE], { total: 10, completed: 3 });
    const result = eta.estimate(goal, { taskState: state });

    assert.equal(result.basis, 'tasks');
    assert.equal(result.unitsRemaining, 7);
    assert.equal(result.n, 3);
    assert.equal(result.remainingMs, 12 * MINUTE * 7);
    assert.ok(result.lowMs <= result.remainingMs && result.remainingMs <= result.highMs, 'the range brackets the point');
  });

  it('says nothing at all below the observation floor', () => {
    // Not a wide range: nothing. A range wide enough to be honest about two
    // samples is a range nobody can act on.
    for (const durations of [[], [10 * MINUTE], [10 * MINUTE, 12 * MINUTE]]) {
      const state = taskState(durations, { total: 10, completed: durations.length });
      assert.equal(eta.estimate(goal, { taskState: state }), null, `${durations.length} samples must not estimate`);
    }
  });

  it('says nothing when there is no work left to estimate', () => {
    const state = taskState([10 * MINUTE, 11 * MINUTE, 12 * MINUTE], { total: 3, completed: 3 });
    assert.equal(eta.estimate(goal, { taskState: state }), null);
  });

  it('carries the count of durations that rest on a guessed match', () => {
    const state = taskState([10 * MINUTE, 11 * MINUTE, 12 * MINUTE], { total: 6, completed: 3, fuzzyDurations: 2 });
    assert.equal(eta.estimate(goal, { taskState: state }).fuzzy, 2);
  });
});

describe('estimate — the continuation basis', () => {
  const at = (...minutes) => ({
    continuations: minutes.length,
    continuationAt: minutes.map((m) => new Date(Date.parse('2026-07-30T10:00:00.000Z') + m * MINUTE).toISOString()),
  });
  const covered = (n, total) =>
    Array.from({ length: total }, (_, i) => ({ criterion: i + 1, state: i < n ? 'covered' : 'uncovered' }));

  it('takes over when there is no task list, which is the common case', () => {
    const result = eta.estimate(at(0, 12, 25, 36), { coverage: covered(2, 5) });
    assert.equal(result.basis, 'continuations');
    // Four rounds got 2 of 5 criteria, so the objective projects to 10 rounds and
    // six remain.
    assert.equal(result.unitsRemaining, 6);
    assert.equal(result.n, 3, 'four timestamps are three intervals');
  });

  it('prefers the task basis when both are available', () => {
    const state = taskState([10 * MINUTE, 11 * MINUTE, 12 * MINUTE], { total: 6, completed: 3 });
    const result = eta.estimate(at(0, 12, 25, 36), { taskState: state, coverage: covered(2, 5) });
    assert.equal(result.basis, 'tasks');
  });

  it('declines to guess when nothing is covered yet', () => {
    assert.equal(eta.estimate(at(0, 12, 25, 36), { coverage: covered(0, 5) }), null);
  });

  it('does not count an asserted criterion as progress', () => {
    // claimed-only is the model's word for it. Counting it would let the estimator
    // be talked into optimism, which is the one direction that matters.
    const claimed = [
      { criterion: 1, state: 'claimed-only' },
      { criterion: 2, state: 'claimed-only' },
      { criterion: 3, state: 'uncovered' },
    ];
    assert.equal(eta.estimate(at(0, 12, 25, 36), { coverage: claimed }), null);
  });

  it('reports nothing remaining once the whole bar is met', () => {
    assert.equal(eta.estimate(at(0, 12, 25), { coverage: covered(3, 3) }), null);
  });

  it('needs more than one interval before it will speak', () => {
    assert.equal(eta.estimate(at(0, 12), { coverage: covered(1, 4) }), null);
  });
});

describe('estimate — refusals', () => {
  it('returns null for no goal and for a goal with nothing recorded', () => {
    assert.equal(eta.estimate(null, {}), null);
    assert.equal(eta.estimate({ continuations: 0, continuationAt: [] }, {}), null);
  });

  it('never produces a negative estimate from a clock that moved backwards', () => {
    const backwards = {
      continuations: 3,
      continuationAt: ['2026-07-30T12:00:00.000Z', '2026-07-30T11:00:00.000Z', '2026-07-30T13:00:00.000Z'],
    };
    const result = eta.estimate(backwards, {
      coverage: [
        { criterion: 1, state: 'covered' },
        { criterion: 2, state: 'uncovered' },
      ],
    });
    if (result) assert.ok(result.remainingMs >= 0);
  });
});

describe('render', () => {
  it('marks the number as an estimate and shows what it rests on', () => {
    const state = taskState([10 * MINUTE, 12 * MINUTE, 23 * MINUTE], { total: 10, completed: 3 });
    const line = eta.render(eta.estimate({ continuations: 2, continuationAt: [] }, { taskState: state }), {
      formatDuration,
    });
    assert.match(line, /^~/, 'the tilde is what separates this from the measured figures beside it');
    assert.match(line, /7 tasks left/);
    assert.match(line, /range /);
  });

  it('is empty for no estimate, so a caller can omit the clause entirely', () => {
    assert.equal(eta.render(null, { formatDuration }), '');
    assert.equal(eta.render({ remainingMs: null }, { formatDuration }), '');
  });

  it('says "round" on the continuation basis and gets the plural right', () => {
    const one = eta.render({ remainingMs: 5 * MINUTE, basis: 'continuations', unitsRemaining: 1 }, { formatDuration });
    assert.match(one, /1 round left/);
    const many = eta.render({ remainingMs: 5 * MINUTE, basis: 'continuations', unitsRemaining: 3 }, { formatDuration });
    assert.match(many, /3 rounds left/);
  });
});

describe('baseline', () => {
  it('is the dumbest thing that could work, and is what ships if it wins', () => {
    const state = taskState([10 * MINUTE, 12 * MINUTE, 23 * MINUTE], { total: 10, completed: 3 });
    assert.equal(eta.baseline({}, { taskState: state }).remainingMs, 12 * MINUTE * 7);
  });

  it('is defined even on one sample, where the real estimator refuses', () => {
    const state = taskState([10 * MINUTE], { total: 4, completed: 1 });
    assert.equal(eta.baseline({}, { taskState: state }).remainingMs, 30 * MINUTE);
    assert.equal(eta.estimate({ continuations: 1, continuationAt: [] }, { taskState: state }), null);
  });
});
