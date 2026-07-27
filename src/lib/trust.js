'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { homeDir } = require('./config');
const project = require('./project');
const store = require('./store');

/**
 * Trust-on-first-use for a manifest that lives in the repository.
 *
 * A probe manifest is committed, which is the point — a project knows how to
 * verify itself and that knowledge belongs next to the code. It is also
 * arbitrary shell execution the moment somebody opens the repository, which
 * would make Bandaid an RCE vector for every project you clone.
 *
 * So a manifest runs nothing until its exact contents have been approved, the
 * way direnv and mise handle the same problem. Change one byte and it goes back
 * to approving. This is not a later phase: an untrusted-by-default loader that
 * gains trust afterwards has a window in which it is the bug.
 */

function trustFile() {
  return path.join(homeDir(), 'trust.json');
}

function readTrust() {
  return store.readJson(trustFile(), {}) || {};
}

function hashFile(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * A manifest somebody else can rewrite is not made safe by having been approved
 * once, so ownership and writability are checked separately from the hash.
 *
 * ponytail: world-writable, or owned by another user. Group-write is
 * deliberately *not* refused — a umask of 002 is the default on several
 * distributions, so refusing it would reject nearly every manifest on those
 * machines while the directory above it is still 0755 and the group is usually
 * the user's own. The upgrade path is checking group membership, which needs
 * more than `fs.stat` gives.
 */
function writableByOthers(file) {
  try {
    const stat = fs.statSync(file);
    if ((stat.mode & 0o002) !== 0) return true;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * `{ state, sha256, reason }` where state is one of:
 *   'trusted'    — approved, and the file still hashes to what was approved
 *   'unknown'    — never approved
 *   'changed'    — approved once, edited since
 *   'unsafe'     — world-writable or another user's, which no approval survives
 *   'missing'    — no manifest here at all
 */
function status(cwd, file) {
  if (!file || !fs.existsSync(file)) return { state: 'missing', sha256: null, reason: 'no manifest' };

  if (writableByOthers(file)) {
    return { state: 'unsafe', sha256: null, reason: `${file} is world-writable or owned by another user` };
  }

  const sha256 = hashFile(file);
  if (!sha256) return { state: 'missing', sha256: null, reason: 'manifest unreadable' };

  const record = readTrust()[project.projectKey(cwd)];
  if (!record) return { state: 'unknown', sha256, reason: 'never approved' };
  if (record.sha256 !== sha256) return { state: 'changed', sha256, reason: 'approved once, edited since' };
  return { state: 'trusted', sha256, reason: null };
}

function isTrusted(cwd, file) {
  return status(cwd, file).state === 'trusted';
}

function trust(cwd, file) {
  const current = status(cwd, file);
  if (current.state === 'missing' || current.state === 'unsafe') return current;

  const record = readTrust();
  record[project.projectKey(cwd)] = {
    sha256: current.sha256,
    approvedAt: new Date().toISOString(),
    root: project.projectRoot(cwd),
    file,
  };
  store.writeJson(trustFile(), record);
  return { ...current, state: 'trusted', reason: null };
}

function untrust(cwd) {
  const record = readTrust();
  delete record[project.projectKey(cwd)];
  store.writeJson(trustFile(), record);
}

/** What was approved, so `probes trust` can show a diff rather than a hash. */
function approved(cwd) {
  return readTrust()[project.projectKey(cwd)] || null;
}

module.exports = { approved, hashFile, isTrusted, status, trust, trustFile, untrust, writableByOthers };
