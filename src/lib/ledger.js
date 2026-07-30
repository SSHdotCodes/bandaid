'use strict';

const crypto = require('node:crypto');

const store = require('./store');
const { readPromptsFromTranscript } = require('./transcript');

/**
 * Ledger maintenance shared by several hooks: turn numbering, backfilling from
 * Claude Code's own transcript, and adopting a previous session's ledger when a
 * conversation is resumed or forked under a new session id.
 */

function fingerprint(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 16);
}

function currentTurnIndex(sessionId) {
  const meta = store.readMeta(sessionId);
  return Number.isFinite(meta.turnIndex) ? meta.turnIndex : 0;
}

function bumpTurnIndex(sessionId) {
  const next = currentTurnIndex(sessionId) + 1;
  store.updateMeta(sessionId, { turnIndex: next });
  return next;
}

/**
 * Merge any prompts present in the live transcript but missing from the ledger.
 * This is what makes a mid-session install honest: the very first compaction
 * after `/plugin install` still replays everything the user typed before it.
 */
function backfillFromTranscript(sessionId, transcriptPath) {
  if (!transcriptPath) return 0;

  const existing = store.readPrompts(sessionId);
  const seen = new Set(existing.map((p) => p.promptId || fingerprint(p.text)));

  const fromTranscript = readPromptsFromTranscript(transcriptPath);
  const missing = fromTranscript.filter((p) => !seen.has(p.promptId || fingerprint(p.text)));
  if (!missing.length) return 0;

  // Order matters: the ledger is read newest-last, so a backfill that lands
  // after live prompts would misorder history. Rewrite the whole file instead.
  const merged = [...missing, ...existing].sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  store.ensureSessionDir(sessionId);
  require('node:fs').writeFileSync(
    store.promptsFile(sessionId),
    merged.map((p) => JSON.stringify(p)).join('\n') + (merged.length ? '\n' : ''),
  );

  const patch = {};
  if (merged.length > currentTurnIndex(sessionId)) patch.turnIndex = merged.length;
  // A mid-session install replays prompts from before Bandaid existed, and the
  // oldest of them is when this session actually began. Without this a session
  // Bandaid joined at hour three would report itself as newborn.
  if (!store.readMeta(sessionId).startedAt && merged[0] && merged[0].ts) {
    patch.startedAt = merged[0].ts;
  }
  if (Object.keys(patch).length) store.updateMeta(sessionId, patch);
  return missing.length;
}

/**
 * Resume and fork hand the session a new id with an empty ledger. If the same
 * cwd was previously driven by another session that does have a ledger, carry
 * it forward rather than starting blind.
 *
 * `previousSessionId` must be captured *before* the caller repoints the per-cwd
 * pointer at itself, otherwise there is nothing left to adopt from.
 */
function adoptPreviousLedger(sessionId, cwd, previousSessionId = null) {
  if (store.readPrompts(sessionId).length) return false;

  const previous = previousSessionId || store.getCurrentSession(cwd);
  if (!previous || previous === sessionId) return false;

  const prompts = store.readPrompts(previous);
  if (!prompts.length) return false;

  const fs = require('node:fs');
  store.ensureSessionDir(sessionId);
  fs.copyFileSync(store.promptsFile(previous), store.promptsFile(sessionId));
  try {
    fs.copyFileSync(store.turnsFile(previous), store.turnsFile(sessionId));
  } catch {
    // A session with prompts but no tool calls is legitimate.
  }
  try {
    const tasksFile = require('./tasks').tasksFile;
    fs.copyFileSync(tasksFile(previous), tasksFile(sessionId));
  } catch {
    // Likewise: plenty of sessions never write a task list.
  }
  adoptGoal(sessionId, previous);
  // Session age travels with the ledger it describes. A resume that minted a new
  // id would otherwise restart the clock on a conversation that has been running
  // for hours, which is precisely the multi-day case this all exists for.
  store.updateMeta(sessionId, {
    turnIndex: prompts.length,
    adoptedFrom: previous,
    startedAt: store.sessionStartedAt(previous) || prompts[0]?.ts || null,
  });
  return true;
}

/**
 * Carry a still-open objective across a resume.
 *
 * The prompts and the digests were already being copied; the goal was not, so a
 * resume that mints a new session id kept the history of an objective the
 * session no longer had — and the `<bandaid-active-goal>` block SessionStart
 * emits for exactly this case could never fire.
 *
 * Only an active goal moves. A completed or blocked one is history, and
 * re-arming a stop that has already been settled is worse than losing it.
 */
function adoptGoal(sessionId, previousSessionId) {
  const goal = store.readGoal(previousSessionId);
  if (!goal || goal.status !== 'active' || !goal.objective) return false;
  // Never overwrite: a goal already here won the race and is the live one.
  if (store.readGoal(sessionId)) return false;
  store.writeGoal(sessionId, goal);
  return true;
}

function batchesForTurn(sessionId, turnIndex) {
  return store.readTurns(sessionId).filter((t) => t.turnIndex === turnIndex);
}

module.exports = {
  adoptGoal,
  adoptPreviousLedger,
  backfillFromTranscript,
  batchesForTurn,
  bumpTurnIndex,
  currentTurnIndex,
  fingerprint,
};
