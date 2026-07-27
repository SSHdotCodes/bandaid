'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { homeDir } = require('./config');

/**
 * On-disk session ledger.
 *
 * Claude Code's compaction throws away the raw conversation and keeps only a
 * summary. Bandaid's ledger is the durable copy: every user prompt verbatim,
 * plus a per-turn digest of tool calls, written as they happen so they survive
 * a compaction that has already discarded them from the context window.
 */

function sessionsDir() {
  return path.join(homeDir(), 'sessions');
}

function pointerDir() {
  return path.join(homeDir(), 'current');
}

function sanitizeId(sessionId) {
  const id = String(sessionId || '').trim();
  // Session ids are UUIDs, but never trust an id straight into a path.
  return /^[A-Za-z0-9._-]{1,128}$/.test(id) && id !== '.' && id !== '..' ? id : null;
}

function sessionDir(sessionId) {
  const id = sanitizeId(sessionId);
  if (!id) throw new Error(`bandaid: refusing to use unsafe session id ${JSON.stringify(sessionId)}`);
  return path.join(sessionsDir(), id);
}

function ensureSessionDir(sessionId) {
  const dir = sessionDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // A torn final line from a killed hook should not poison the ledger.
    }
  }
  return out;
}

const TAIL_CHUNK_BYTES = 256 * 1024;

/**
 * Read a JSONL file backwards, stopping as soon as `enough(records)` says the
 * caller has what it came for.
 *
 * `readJsonl` reads and parses the whole file, which is fine for a prompt
 * ledger and wrong for a turn ledger: `turns.jsonl` reaches megabytes over a
 * multi-day session and is read on every single Stop, inside a hook with a
 * timeout. The cost only shows up on day three, which is exactly when a
 * long-horizon goal is still running.
 *
 * A partial line at a chunk boundary is dropped rather than parsed — it is
 * whole only once the read reaches the start of the file — which also disposes
 * of a multi-byte character split across the boundary.
 *
 * ponytail: re-parses the accumulated buffer on each chunk, so it is O(chunks²)
 * in parse work. Chunks are 256 KiB and callers stop after one or two, so this
 * is cheaper than the index file it would take to avoid. The upgrade path is a
 * sidecar offset index, worth it only if a real ledger shows the walk going
 * deep.
 */
function readJsonlBackwards(file, enough) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return [];
  }

  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return [];

    let start = size;
    let buffer = Buffer.alloc(0);
    let records = [];

    while (start > 0) {
      const chunkStart = Math.max(0, start - TAIL_CHUNK_BYTES);
      const length = start - chunkStart;
      const chunk = Buffer.alloc(length);
      fs.readSync(fd, chunk, 0, length, chunkStart);
      buffer = Buffer.concat([chunk, buffer]);
      start = chunkStart;

      const lines = buffer.toString('utf8').split('\n');
      const whole = start === 0 ? lines : lines.slice(1);

      records = [];
      for (const line of whole) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          records.push(JSON.parse(trimmed));
        } catch {
          // A torn final line from a killed hook should not poison the ledger.
        }
      }

      if (enough(records)) break;
    }

    return records;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already gone */
    }
  }
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// --- prompts -------------------------------------------------------------

function promptsFile(sessionId) {
  return path.join(sessionDir(sessionId), 'prompts.jsonl');
}

function recordPrompt(sessionId, { text, promptId = null, cwd = null, ts = null }) {
  if (!text || !text.trim()) return null;
  const record = {
    ts: ts || new Date().toISOString(),
    promptId,
    cwd,
    text,
  };
  ensureSessionDir(sessionId);
  appendJsonl(promptsFile(sessionId), record);
  return record;
}

function readPrompts(sessionId) {
  return readJsonl(promptsFile(sessionId));
}

// --- turn digests --------------------------------------------------------

function turnsFile(sessionId) {
  return path.join(sessionDir(sessionId), 'turns.jsonl');
}

function recordTurn(sessionId, record) {
  ensureSessionDir(sessionId);
  appendJsonl(turnsFile(sessionId), { ts: new Date().toISOString(), ...record });
}

function readTurns(sessionId) {
  return readJsonl(turnsFile(sessionId));
}

/**
 * The turns belonging to one goal, without reading the ones that do not.
 *
 * Walks backwards until it has seen a turn from before `turnIndex`, which
 * proves the goal's own range is complete. A goal set at turn 0 wants the whole
 * file, so it takes the ordinary read.
 */
function readTurnsSince(sessionId, turnIndex) {
  if (!Number.isFinite(turnIndex) || turnIndex <= 0) return readTurns(sessionId);

  const records = readJsonlBackwards(turnsFile(sessionId), (found) => {
    if (!found.length) return false;
    const oldest = found[0];
    return Number.isFinite(oldest.turnIndex) && oldest.turnIndex < turnIndex;
  });

  return records.filter((turn) => !Number.isFinite(turn.turnIndex) || turn.turnIndex >= turnIndex);
}

// --- goal ----------------------------------------------------------------

function goalFile(sessionId) {
  return path.join(sessionDir(sessionId), 'goal.json');
}

function readGoal(sessionId) {
  try {
    return readJson(goalFile(sessionId));
  } catch {
    return null;
  }
}

function writeGoal(sessionId, goal) {
  ensureSessionDir(sessionId);
  writeJson(goalFile(sessionId), goal);
  return goal;
}

function clearGoal(sessionId) {
  try {
    fs.rmSync(goalFile(sessionId), { force: true });
  } catch {
    /* nothing to clear */
  }
}

// --- meta / bookkeeping --------------------------------------------------

function metaFile(sessionId) {
  return path.join(sessionDir(sessionId), 'meta.json');
}

function readMeta(sessionId) {
  try {
    return readJson(metaFile(sessionId), {}) || {};
  } catch {
    return {};
  }
}

function updateMeta(sessionId, patch) {
  ensureSessionDir(sessionId);
  const next = { ...readMeta(sessionId), ...patch };
  writeJson(metaFile(sessionId), next);
  return next;
}

// --- global state --------------------------------------------------------

function stateFile() {
  return path.join(homeDir(), 'state.json');
}

function readState() {
  return readJson(stateFile(), {}) || {};
}

function updateState(patch) {
  const next = { ...readState(), ...patch };
  writeJson(stateFile(), next);
  return next;
}

// --- retention -----------------------------------------------------------

/**
 * Every session ever started, newest first, with just enough to decide whether
 * it is still worth keeping.
 */
function listSessions() {
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir(), { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !sanitizeId(entry.name)) continue;
    const dir = path.join(sessionsDir(), entry.name);
    let mtimeMs = 0;
    try {
      // The ledger files move; the directory's own mtime does not once the
      // files inside it are only appended to.
      for (const file of ['turns.jsonl', 'prompts.jsonl', 'goal.json', 'meta.json']) {
        try {
          mtimeMs = Math.max(mtimeMs, fs.statSync(path.join(dir, file)).mtimeMs);
        } catch {
          /* not every session has every file */
        }
      }
      if (!mtimeMs) mtimeMs = fs.statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    const goal = readGoal(entry.name);
    out.push({ id: entry.name, dir, mtimeMs, goalStatus: goal ? goal.status : null });
  }

  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Delete session directories nothing will read again.
 *
 * Bandaid has never deleted anything: one directory per session, forever, and
 * a turns.jsonl that reaches megabytes in a day. That is untidy in a one-day
 * session and a real cost in a multi-day one.
 *
 * A session with an **active** goal is never pruned, whatever its age. That is
 * precisely the long-horizon case, and deleting it is the failure the goal
 * system exists to prevent.
 */
function pruneSessions({ maxAgeDays = 30, maxCount = 200, dryRun = false, now = Date.now() } = {}) {
  const sessions = listSessions();
  const cutoff = maxAgeDays > 0 ? now - maxAgeDays * 24 * 60 * 60 * 1000 : null;

  const removable = [];
  let keptCount = 0;

  for (const session of sessions) {
    if (session.goalStatus === 'active') {
      keptCount += 1;
      continue;
    }
    const tooOld = cutoff != null && session.mtimeMs < cutoff;
    const overCount = maxCount > 0 && keptCount >= maxCount;
    if (tooOld || overCount) removable.push(session);
    else keptCount += 1;
  }

  if (!dryRun) {
    for (const session of removable) {
      try {
        fs.rmSync(session.dir, { recursive: true, force: true });
      } catch {
        /* a directory we cannot remove is not worth failing a hook over */
      }
    }
  }

  return { removed: removable.map((s) => s.id), kept: keptCount, dryRun };
}

// --- current-session pointer --------------------------------------------

/**
 * Slash commands run in a shell that may not carry CLAUDE_SESSION_ID on every
 * Claude Code build, so each hook drops a per-cwd pointer to the live session.
 */
function pointerFile(cwd) {
  const key = crypto.createHash('sha256').update(String(cwd || process.cwd())).digest('hex').slice(0, 16);
  return path.join(pointerDir(), `${key}.json`);
}

function setCurrentSession(sessionId, cwd) {
  const id = sanitizeId(sessionId);
  if (!id) return;
  writeJson(pointerFile(cwd), { sessionId: id, cwd: cwd || process.cwd(), ts: new Date().toISOString() });
}

function getCurrentSession(cwd) {
  const explicit = sanitizeId(process.env.CLAUDE_SESSION_ID);
  if (explicit) return explicit;
  const pointer = readJson(pointerFile(cwd));
  return pointer && sanitizeId(pointer.sessionId) ? pointer.sessionId : null;
}

module.exports = {
  appendJsonl,
  clearGoal,
  ensureSessionDir,
  getCurrentSession,
  goalFile,
  listSessions,
  promptsFile,
  pruneSessions,
  readState,
  updateState,
  readGoal,
  readJson,
  readJsonl,
  readMeta,
  readJsonlBackwards,
  readPrompts,
  readTurns,
  readTurnsSince,
  recordPrompt,
  recordTurn,
  sanitizeId,
  sessionDir,
  sessionsDir,
  setCurrentSession,
  turnsFile,
  updateMeta,
  writeGoal,
  writeJson,
};
