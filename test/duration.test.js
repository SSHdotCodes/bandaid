'use strict';

/**
 * The clock, which Bandaid did not have.
 *
 * Two classes of failure this exists to catch. A duration parsed wrongly caps
 * work at a number nobody chose, silently — so the parser has to reject rather
 * than guess. And every render here reaches a prompt golden, so a formatter that
 * reads the ambient clock or the ambient timezone makes those goldens fail on
 * somebody else's machine.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  MINUTE,
  HOUR,
  DAY,
  elapsedSince,
  formatBudget,
  formatClock,
  formatDuration,
  parseDuration,
  timeUsedMs,
} = require('../src/lib/duration');

describe('parseDuration', () => {
  it('reads the forms a person actually types', () => {
    assert.equal(parseDuration('90m'), 90 * MINUTE);
    assert.equal(parseDuration('2h'), 2 * HOUR);
    assert.equal(parseDuration('45s'), 45_000);
    assert.equal(parseDuration('3d'), 3 * DAY);
    assert.equal(parseDuration('500ms'), 500);
  });

  it('sums compound forms', () => {
    assert.equal(parseDuration('1h30m'), 90 * MINUTE);
    assert.equal(parseDuration('2h15m30s'), 2 * HOUR + 15 * MINUTE + 30_000);
  });

  it('treats a bare number as milliseconds, matching the config key it feeds', () => {
    assert.equal(parseDuration('5400000'), 5_400_000);
    assert.equal(parseDuration(5_400_000), 5_400_000);
  });

  it('is case-insensitive and tolerates surrounding space', () => {
    assert.equal(parseDuration('  2H  '), 2 * HOUR);
  });

  it('rejects rather than guesses, because a wrong budget is worse than none', () => {
    for (const bad of ['', '   ', 'soon', '-5m', '0', '0m', 'h', '1h 30m', '1x', 'NaN', null, undefined, {}]) {
      assert.equal(parseDuration(bad), null, `${JSON.stringify(bad)} must not parse`);
    }
  });

  it('rejects a bare number of 5 as a unit-less token only when it is not milliseconds', () => {
    // '5' is 5ms, which is a legitimate if useless budget; '0' is not a budget.
    assert.equal(parseDuration('5'), 5);
    assert.equal(parseDuration('0'), null);
  });
});

describe('formatDuration', () => {
  it('is coarse on purpose — seconds in a prompt are noise', () => {
    assert.equal(formatDuration(0), 'just now');
    assert.equal(formatDuration(42_000), 'just now');
    assert.equal(formatDuration(11 * MINUTE), '11m');
    assert.equal(formatDuration(11 * MINUTE + 59_000), '11m');
  });

  it('drops a zero minute rather than rendering "3h 0m"', () => {
    assert.equal(formatDuration(3 * HOUR), '3h');
    assert.equal(formatDuration(3 * HOUR + 18 * MINUTE), '3h 18m');
  });

  it('rolls over to days for a multi-day objective', () => {
    assert.equal(formatDuration(DAY), '1d');
    assert.equal(formatDuration(2 * DAY + 5 * HOUR), '2d 5h');
  });

  it('clamps a negative elapsed instead of rendering time added back', () => {
    assert.equal(formatDuration(-60_000), 'just now');
  });

  it('returns null for nothing to say, so a caller can omit the line', () => {
    assert.equal(formatDuration(null), null);
    assert.equal(formatDuration(NaN), null);
  });
});

describe('formatBudget', () => {
  it('renders a sub-minute budget as a number, where an elapsed would say "just now"', () => {
    assert.equal(formatBudget(30_000), '30s');
    assert.equal(formatDuration(30_000), 'just now');
  });

  it('has nothing to say about an absent or nonsense budget', () => {
    assert.equal(formatBudget(null), null);
    assert.equal(formatBudget(0), null);
    assert.equal(formatBudget(-1), null);
  });
});

describe('formatClock', () => {
  const NOON_UTC = Date.parse('2026-07-30T16:42:00.000Z');

  it('takes the offset explicitly, so a golden does not depend on the machine', () => {
    assert.equal(formatClock(NOON_UTC, { offsetMinutes: 0 }), '16:42 (Thu 30 Jul)');
    assert.equal(formatClock(NOON_UTC, { offsetMinutes: 60 }), '17:42 (Thu 30 Jul)');
    assert.equal(formatClock(NOON_UTC, { offsetMinutes: -480 }), '08:42 (Thu 30 Jul)');
  });

  it('carries the weekday across a date boundary the offset caused', () => {
    assert.equal(formatClock(Date.parse('2026-07-30T23:30:00.000Z'), { offsetMinutes: 60 }), '00:30 (Fri 31 Jul)');
  });

  it('pads to two digits so the column does not move between turns', () => {
    assert.equal(formatClock(Date.parse('2026-07-05T04:07:00.000Z'), { offsetMinutes: 0 }), '04:07 (Sun 5 Jul)');
  });

  it('accepts a Date as readily as a number', () => {
    assert.equal(formatClock(new Date(NOON_UTC), { offsetMinutes: 0 }), '16:42 (Thu 30 Jul)');
  });
});

describe('elapsedSince', () => {
  const now = Date.parse('2026-07-30T16:42:00.000Z');

  it('measures forward', () => {
    assert.equal(elapsedSince('2026-07-30T16:31:00.000Z', now), 11 * MINUTE);
  });

  it('never goes negative on a clock that moved backwards', () => {
    assert.equal(elapsedSince('2026-07-30T17:00:00.000Z', now), 0);
  });

  it('returns null for an unparseable or absent stamp, not 0', () => {
    assert.equal(elapsedSince(null, now), null);
    assert.equal(elapsedSince('', now), null);
    assert.equal(elapsedSince('not a date', now), null);
  });
});

describe('timeUsedMs', () => {
  const now = Date.parse('2026-07-30T16:42:00.000Z');

  it('measures from startedAt, which an adoption resets', () => {
    const goal = { startedAt: '2026-07-30T13:24:00.000Z', createdAt: '2026-07-28T09:00:00.000Z' };
    assert.equal(timeUsedMs(goal, now), 3 * HOUR + 18 * MINUTE);
  });

  it('falls back to createdAt for a record written before startedAt existed', () => {
    assert.equal(timeUsedMs({ createdAt: '2026-07-30T15:42:00.000Z' }, now), HOUR);
  });

  it('distinguishes "no time has passed" from "we do not know when this started"', () => {
    assert.equal(timeUsedMs({ startedAt: '2026-07-30T16:42:00.000Z' }, now), 0);
    assert.equal(timeUsedMs({}, now), null);
    assert.equal(timeUsedMs(null, now), null);
  });
});
