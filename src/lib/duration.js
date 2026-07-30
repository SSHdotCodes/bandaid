'use strict';

/**
 * Wall-clock formatting and parsing.
 *
 * Bandaid had no notion of elapsed time before this: every record carried a
 * timestamp and nothing ever subtracted two of them. The one exception was the
 * probe-age line in prompts.js, which is the shape everything here follows —
 * the clock arrives as a parameter so a prompt golden can pin it.
 *
 * `formatClock` takes an explicit UTC offset for the same reason. Rendering
 * local time from the ambient timezone would make every golden depend on the
 * machine that recorded it, and test/prompts.snapshot.test.js exists precisely
 * so nothing here depends on the environment.
 */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const UNITS = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };

const MINUTE = UNITS.m;
const HOUR = UNITS.h;
const DAY = UNITS.d;

/**
 * "90m", "2h", "1h30m", "45s", "5400000" → milliseconds. Anything else → null.
 *
 * Returns null rather than guessing: a budget parsed wrongly is worse than one
 * rejected, because it silently caps work at a number nobody chose.
 */
function parseDuration(input) {
  if (typeof input === 'number') {
    return Number.isFinite(input) && input > 0 ? Math.round(input) : null;
  }
  const text = String(input == null ? '' : input).trim().toLowerCase();
  if (!text) return null;

  // A bare number is milliseconds, matching the config key it feeds.
  if (/^\d+$/.test(text)) {
    const ms = Number(text);
    return ms > 0 ? ms : null;
  }

  // One or more <number><unit> pairs and nothing else: "1h30m" but not "1h 30".
  if (!/^(\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/.test(text)) return null;

  let total = 0;
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    total += Number(match[1]) * UNITS[match[2]];
  }
  return total > 0 ? Math.round(total) : null;
}

/**
 * Coarse by design. A second-precision figure in a prompt invites arithmetic
 * nobody needs and spends tokens on noise, so the smallest unit rendered is a
 * minute and anything under one is "just now".
 */
function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const clamped = Math.max(0, ms);

  if (clamped < MINUTE) return 'just now';
  if (clamped < HOUR) return `${Math.floor(clamped / MINUTE)}m`;

  if (clamped < DAY) {
    const hours = Math.floor(clamped / HOUR);
    const minutes = Math.floor((clamped % HOUR) / MINUTE);
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  const days = Math.floor(clamped / DAY);
  const hours = Math.floor((clamped % DAY) / HOUR);
  return hours ? `${days}d ${hours}h` : `${days}d`;
}

/**
 * A budget renders as its own coarse figure, so "of 6h" reads as a limit rather
 * than as a measurement. Distinct from formatDuration only in that a budget
 * under a minute is still a number, not "just now".
 */
function formatBudget(ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < MINUTE) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return formatDuration(ms);
}

/**
 * "16:42 (Thu 30 Jul)". The weekday is the part that changes a decision — is it
 * still the day the user asked? — so it is in and the year and zone name are not.
 */
function formatClock(now, { offsetMinutes = null } = {}) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(ms)) return null;

  const offset = offsetMinutes == null ? -new Date(ms).getTimezoneOffset() : offsetMinutes;
  const shifted = new Date(ms + offset * MINUTE);

  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} (${DAYS[shifted.getUTCDay()]} ${shifted.getUTCDate()} ${MONTHS[shifted.getUTCMonth()]})`;
}

/**
 * Elapsed milliseconds between an ISO timestamp and now.
 *
 * Clamps at zero. A clock that moved backwards is a real thing — see
 * test/project.test.js, which already asserts ageInDays never goes negative —
 * and a negative elapsed would render as a budget with time added to it.
 */
function elapsedSince(iso, now = Date.now()) {
  const then = Date.parse(String(iso || ''));
  if (!Number.isFinite(then)) return null;
  return Math.max(0, now - then);
}

/**
 * Wall-clock a goal's current budget has consumed.
 *
 * Measured from `startedAt`, which an adoption resets, falling back to
 * `createdAt` for a goal record written before that field existed. Returns null
 * rather than 0 when there is nothing to measure from, so a caller can tell "no
 * time has passed" from "we do not know when this started".
 *
 * It lives here rather than in goals.js because prompts.js needs it too, and
 * prompts.js cannot require goals.js — restore.js already requires prompts.js,
 * so that edge would close a cycle.
 */
function timeUsedMs(goal, now = Date.now()) {
  if (!goal) return null;
  return elapsedSince(goal.startedAt || goal.createdAt, now);
}

module.exports = {
  DAY,
  HOUR,
  MINUTE,
  elapsedSince,
  timeUsedMs,
  formatBudget,
  formatClock,
  formatDuration,
  parseDuration,
};
