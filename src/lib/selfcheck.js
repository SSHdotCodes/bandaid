'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { changedPaths } = require('./stamp');
const { globToRegExp } = require('./probes');

/**
 * Two mechanical self-checks, neither of which is a second judge.
 *
 * The judge is already "a different model, reading the repository". Building
 * another one wearing a different hat would add cost and no information. What
 * is missing is cheaper and stranger than that.
 *
 * **Expectations** are predictions. The model records what a command will say
 * *at the moment it makes the edit*, and the runtime runs them at every stop.
 * The value is entirely in the timing: an assertion recorded as the work
 * happens is a prediction, while the same claim at the end of the turn is a
 * memory — and memory is exactly what this system distrusts. A model that
 * predicts `grep -c retryLegacy` will say `0`, then measures `3`, has caught
 * itself with no second model involved and no tokens spent.
 *
 * **Scope** replaces a paragraph with set membership. `extractConstraints` is a
 * regex over the objective's clauses that both over- and under-matches, and the
 * continuation prompt spends a paragraph asking the model to respect its
 * output. Declared paths turn "do NOT touch the billing module" into
 * `!globMatch(changed, declared)`.
 */

const EXPECT_TIMEOUT_MS = 30000;

function normalize(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

/**
 * Record one prediction. Returns the new list, or null when there is nothing
 * to record.
 *
 * Deliberately append-only and duplicate-free: an expectation the model quietly
 * rewrites after seeing it fail is not a prediction any more.
 */
function addExpectation(expectations, { command = null, file = null, says = null, contains = null } = {}) {
  const list = Array.isArray(expectations) ? [...expectations] : [];

  const entry = command
    ? { kind: 'command', command: String(command).trim(), says: says == null ? null : String(says) }
    : file
      ? { kind: 'file', file: String(file).trim(), contains: contains == null ? null : String(contains) }
      : null;

  if (!entry) return null;
  if (entry.kind === 'command' && !entry.command) return null;
  if (entry.kind === 'file' && !entry.file) return null;

  // Identity is what was predicted, not when. Including the timestamp would
  // make every re-record a new entry, which is how a duplicate list quietly
  // becomes a duplicate failure report.
  const identity = (e) => JSON.stringify([e.kind, e.command || e.file, e.says ?? e.contains ?? null]);
  const key = identity(entry);
  if (list.some((existing) => identity(existing) === key)) return list;

  list.push({ ...entry, recordedAt: new Date().toISOString() });
  return list;
}

function describeExpectation(entry) {
  if (entry.kind === 'file') {
    return entry.contains == null
      ? `${entry.file} exists`
      : `${entry.file} contains ${JSON.stringify(entry.contains)}`;
  }
  return entry.says == null ? `\`${entry.command}\` exits 0` : `\`${entry.command}\` says ${JSON.stringify(entry.says)}`;
}

function runOne(entry, cwd) {
  if (entry.kind === 'file') {
    const target = path.isAbsolute(entry.file) ? entry.file : path.join(cwd, entry.file);
    let text;
    try {
      text = fs.readFileSync(target, 'utf8');
    } catch {
      return { ok: false, expected: describeExpectation(entry), actual: 'the file does not exist' };
    }
    if (entry.contains == null) return { ok: true };
    return text.includes(entry.contains)
      ? { ok: true }
      : { ok: false, expected: describeExpectation(entry), actual: 'the file does not contain it' };
  }

  const result = spawnSync(entry.command, {
    shell: true,
    cwd,
    encoding: 'utf8',
    timeout: EXPECT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error) {
    return { ok: false, expected: describeExpectation(entry), actual: `the command could not run: ${result.error.message}` };
  }

  const stdout = normalize(result.stdout);
  if (entry.says == null) {
    return result.status === 0
      ? { ok: true }
      : { ok: false, expected: describeExpectation(entry), actual: `it exited ${result.status}` };
  }

  const expected = normalize(entry.says);
  return stdout === expected
    ? { ok: true }
    : { ok: false, expected: describeExpectation(entry), actual: stdout === '' ? 'it printed nothing' : stdout };
}

/**
 * Run every prediction. `abstain` when none were recorded, which is the
 * ordinary case and must be indistinguishable from the feature not existing.
 */
function runExpectations(goal, { cwd } = {}) {
  const list = (goal && goal.expectations) || [];
  if (!list.length) return { verdict: 'abstain', failures: [], checked: 0 };

  const root = cwd || (goal && goal.projectRoot) || process.cwd();
  const failures = [];
  for (const entry of list) {
    const result = runOne(entry, root);
    if (!result.ok) failures.push(result);
  }

  return {
    verdict: failures.length ? 'fail' : 'pass',
    failures,
    checked: list.length,
  };
}

/**
 * Paths this goal has touched that it said it would not.
 *
 * `abstain` when no scope was declared or when git cannot say what changed —
 * an unknown answer must never read as a violation.
 */
function checkScope(goal, { cwd } = {}) {
  const declared = (goal && goal.scope) || [];
  if (!declared.length) return { verdict: 'abstain', violations: [] };

  const root = cwd || (goal && goal.projectRoot) || process.cwd();
  const changed = changedPaths(root, goal && goal.baseSha);
  if (changed == null) return { verdict: 'abstain', violations: [] };

  const patterns = declared.map(globToRegExp);
  const violations = changed.filter((file) => !patterns.some((re) => re.test(file)));

  return { verdict: violations.length ? 'fail' : 'pass', violations };
}

/** One line per failed prediction, for the continuation prompt. */
function renderFailures(failures) {
  return failures.map((f) => `  ${f.expected}\n    but: ${f.actual}`).join('\n');
}

module.exports = { addExpectation, checkScope, describeExpectation, renderFailures, runExpectations };
