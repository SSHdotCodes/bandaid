'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * A cheap fingerprint of the worktree, and the set of paths a goal has touched.
 *
 * Both answer the same underlying question — *has anything changed since?* —
 * which is what decides whether an old piece of evidence still describes the
 * repository, and which verifiers are even worth running.
 *
 * A time-to-live would be wrong in both directions at once: it re-runs work
 * nothing invalidated, and it trusts a result taken before the edit that broke
 * it. A content fingerprint is exact.
 */

const GIT_TIMEOUT_MS = 3000;

function git(args, cwd) {
  try {
    const result = spawnSync('git', args, {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.error || result.status !== 0) return null;
    return String(result.stdout || '');
  } catch {
    return null;
  }
}

/**
 * Parse `git status --porcelain=v1 -uall` into the paths it names.
 *
 * `-uall` is load-bearing rather than a flag choice. The default collapses an
 * untracked directory to a single entry, so an agent writing a brand-new file
 * into an existing untracked directory would not move the fingerprint — and
 * would then get a cached pass from a verifier that never saw the file. A stale
 * result that looks fresh is the most dangerous thing this module can produce.
 */
function parsePorcelain(text) {
  const paths = [];
  for (const line of String(text || '').split('\n')) {
    if (line.length < 4) continue;
    const rest = line.slice(3);
    // Renames arrive as "old -> new"; the new path is the one that exists.
    const arrow = rest.indexOf(' -> ');
    paths.push(arrow === -1 ? rest : rest.slice(arrow + 4));
  }
  return paths.map(unquote).filter(Boolean);
}

/** git quotes paths containing unusual bytes. Undo just enough of that. */
function unquote(p) {
  const trimmed = p.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed.slice(1, -1);
  }
}

/**
 * Returns `{ fp, method }`. `method` is `'git'` when the fingerprint is
 * trustworthy and `'none'` when there is no version control — in which case
 * every consumer must treat all cached results and all recorded evidence as
 * stale, because without git there is no cheap way to know otherwise.
 */
function worktreeStamp(cwd) {
  const root = cwd || process.cwd();

  const head = git(['rev-parse', 'HEAD'], root);
  const status = git(['status', '--porcelain=v1', '-uall'], root);
  if (head == null || status == null) return { fp: null, method: 'none' };

  const hash = crypto.createHash('sha256');
  hash.update(head.trim());
  hash.update('\n');
  hash.update(status);

  // Porcelain says *that* a file is modified, not what it now contains, so two
  // different edits to one file would otherwise share a fingerprint.
  for (const rel of parsePorcelain(status)) {
    try {
      const stat = fs.statSync(path.join(root, rel));
      hash.update(`\n${rel}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
    } catch {
      hash.update(`\n${rel}:gone`);
    }
  }

  return { fp: hash.digest('hex').slice(0, 24), method: 'git' };
}

/** True when a recorded stamp still describes the worktree in front of us. */
function stampMatches(recorded, current) {
  if (!recorded || !current || !current.fp) return false;
  const fp = typeof recorded === 'string' ? recorded : recorded.fp;
  return Boolean(fp) && fp === current.fp;
}

/**
 * Every path this goal has touched since it was set: committed changes since
 * `baseSha`, plus whatever is dirty or untracked right now.
 *
 * Returns null — meaning "cannot tell" — rather than an empty array when there
 * is no git or no base commit. The difference matters: an empty array says
 * nothing changed, and a consumer that confuses the two will skip a verifier it
 * should have run.
 */
function changedPaths(cwd, baseSha) {
  const root = cwd || process.cwd();

  const status = git(['status', '--porcelain=v1', '-uall'], root);
  if (status == null) return null;

  const paths = new Set(parsePorcelain(status));

  if (baseSha) {
    const committed = git(['diff', '--name-only', `${baseSha}..HEAD`], root);
    if (committed == null) return null;
    for (const line of committed.split('\n')) {
      const rel = unquote(line);
      if (rel) paths.add(rel);
    }
  }

  return [...paths].sort();
}

module.exports = { changedPaths, parsePorcelain, stampMatches, worktreeStamp };
