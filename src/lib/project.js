'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { homeDir } = require('./config');
const store = require('./store');

/**
 * Project identity, and the record of an objective that outlived its session.
 *
 * Everything else Bandaid keeps is scoped to a `session_id`, which is correct
 * for a ledger — a fresh session must not replay another conversation's
 * instructions — and wrong for a goal. Close the terminal on a three-day
 * refactor and the objective, its fixed criteria, its constraints and its
 * blockers were all still on disk under a session id nothing would ever look
 * up again.
 *
 * So the goal gets a second home, keyed by the project rather than the
 * conversation. It is a projection, not the source of truth: the live goal
 * stays at sessions/<id>/goal.json and the hot path is unchanged. This file is
 * read at session start and by the CLI, and written whenever the goal moves.
 */

/**
 * The directory a project is rooted at.
 *
 * The existing per-cwd pointer hashes the working directory, so `claude` run
 * from `src/` is a different project from `claude` run from the repository
 * root. Git already answers this correctly and is present in every repository
 * Bandaid is useful in; a plain directory falls back to itself.
 *
 * ponytail: one `git rev-parse` per call, ~3ms, memoized per process because
 * hooks are short-lived and the CLI asks more than once. The upgrade path is a
 * cache on disk, worth doing only if a hook budget shows this mattering.
 */
const rootCache = new Map();

function projectRoot(cwd) {
  const start = cwd || process.cwd();
  if (rootCache.has(start)) return rootCache.get(start);

  let resolved;
  try {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: start,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const top = result.error || result.status !== 0 ? '' : String(result.stdout || '').trim();
    resolved = top || realpath(start);
  } catch {
    resolved = realpath(start);
  }

  rootCache.set(start, resolved);
  return resolved;
}

function realpath(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

/** Same idiom as the per-cwd session pointer, so the two are recognisably kin. */
function projectKey(cwd) {
  return crypto.createHash('sha256').update(projectRoot(cwd)).digest('hex').slice(0, 16);
}

function projectsDir() {
  return path.join(homeDir(), 'projects');
}

function projectDir(cwd) {
  return path.join(projectsDir(), projectKey(cwd));
}

function handoffFile(cwd) {
  return path.join(projectDir(cwd), 'handoff.json');
}

function readHandoff(cwd) {
  const record = store.readJson(handoffFile(cwd));
  if (!record || typeof record !== 'object' || !record.goal || !record.goal.objective) return null;
  return record;
}

/**
 * Record the current state of an objective against its project.
 *
 * `sessions` is the chain of session ids that have worked this objective. It is
 * what makes a five-day goal auditable, and it is the join key anything
 * accumulating evidence across sessions will need.
 */
function writeHandoff(cwd, sessionId, goal) {
  if (!goal || !goal.objective) return null;

  const existing = readHandoff(cwd);
  const sameObjective = existing && existing.goal.objective === goal.objective;
  const sessions = sameObjective && Array.isArray(existing.goal.sessions) ? [...existing.goal.sessions] : [];
  if (sessionId && !sessions.includes(sessionId)) sessions.push(sessionId);

  const record = {
    projectRoot: projectRoot(cwd),
    sessionId: sessionId || null,
    updatedAt: new Date().toISOString(),
    goal: {
      objective: goal.objective,
      criteria: goal.criteria || [],
      criteriaSource: goal.criteriaSource || null,
      constraints: goal.constraints || [],
      blockers: goal.blockers || [],
      // Carried so an adopted goal does not get a fresh blocker budget for
      // walls that are still standing.
      blockedStreak: goal.blockedStreak || 0,
      check: goal.check ?? null,
      // The held-out command travels with the objective so tomorrow's session
      // inherits the same bar. Its *findings* never enter this record: those stay
      // in the session goal and the ledger, because a handoff is read aloud to a
      // new session by openObjectivePrompt.
      seal: goal.seal ?? null,
      baseSha: goal.baseSha ?? null,
      status: goal.status,
      source: goal.source,
      createdAt: (sameObjective && existing.goal.createdAt) || goal.createdAt,
      continuations: goal.continuations || 0,
      sessions,
    },
  };

  store.writeJson(handoffFile(cwd), record);
  return record;
}

function clearHandoff(cwd) {
  try {
    fs.rmSync(handoffFile(cwd), { force: true });
  } catch {
    /* nothing to clear */
  }
}

/** Whole days, floored, for the "last worked N days ago" line. */
function ageInDays(iso, now = Date.now()) {
  const then = Date.parse(iso || '');
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((now - then) / (24 * 60 * 60 * 1000)));
}

module.exports = {
  ageInDays,
  clearHandoff,
  handoffFile,
  projectDir,
  projectKey,
  projectRoot,
  projectsDir,
  readHandoff,
  writeHandoff,
};
