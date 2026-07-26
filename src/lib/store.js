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
  promptsFile,
  readGoal,
  readJson,
  readJsonl,
  readMeta,
  readPrompts,
  readTurns,
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
