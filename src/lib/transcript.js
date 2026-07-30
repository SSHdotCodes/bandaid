'use strict';

const fs = require('node:fs');

/**
 * Transcript fallback.
 *
 * The UserPromptSubmit hook is the primary source of verbatim prompts, but it
 * only sees prompts submitted while Bandaid was installed. For `--resume`,
 * `--continue`, and freshly installed setups, we backfill from Claude Code's
 * own session JSONL so the first compaction after install is still faithful.
 */

/** A real user prompt, not a tool result and not a synthetic meta message. */
function isUserPromptEntry(entry) {
  if (!entry || entry.type !== 'user') return false;
  if (entry.isSidechain) return false;
  if (entry.isMeta) return false;
  // Tool results are recorded as user-role entries; they carry toolUseResult.
  if (entry.toolUseResult !== undefined) return false;
  if (entry.sourceToolAssistantUUID) return false;
  return true;
}

function entryText(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_result') return '';
    if (typeof block.text === 'string' && block.text) parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * Claude Code injects its compaction summary back as a user message. Replaying
 * an old summary verbatim would defeat the point, so those are filtered out.
 */
function looksLikeCompactSummary(text) {
  if (!text) return true;
  const head = text.slice(0, 400).toLowerCase();
  return (
    head.includes('this session is being continued from a previous conversation') ||
    head.includes('analysis:\n') && head.includes('summary:') ||
    head.startsWith('<bandaid-restored-context')
  );
}

function isCommandNoise(text) {
  const trimmed = text.trim();
  if (!trimmed) return true;
  // Local slash-command plumbing shows up as XML-ish stdout wrappers.
  if (trimmed.startsWith('<command-name>') || trimmed.startsWith('<local-command-stdout>')) return true;
  if (trimmed.startsWith('<user-prompt-submit-hook>')) return true;
  return false;
}

function readPromptsFromTranscript(transcriptPath) {
  if (!transcriptPath) return [];
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return [];
  }

  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isUserPromptEntry(entry)) continue;
    const text = entryText(entry);
    if (!text || isCommandNoise(text) || looksLikeCompactSummary(text)) continue;
    out.push({
      ts: entry.timestamp || null,
      promptId: entry.promptId || null,
      cwd: entry.cwd || null,
      text,
      uuid: entry.uuid || null,
    });
  }
  return out;
}

/**
 * Real per-call tool durations, read out of Claude Code's own transcript.
 *
 * Nothing Bandaid records knows how long a tool took: `recordTurn` stamps one
 * timestamp per batch, at the moment the record is written. The transcript has
 * what is needed and it is exact — an `assistant` entry's `tool_use` block is
 * stamped when the call was issued, and the `user` entry carrying its
 * `tool_result` is stamped when it came back, with `sourceToolAssistantUUID`
 * pointing at the call. The difference is the duration.
 *
 * Measured against a real session before this was written: 172 of 172 calls
 * matched, no negative durations.
 *
 * Two things this measures that are easy to misread, and that callers must not
 * average away. An asynchronous tool records the time its *call* took, not its
 * work — a backgrounded agent looks like 20ms. And a tool that waits for a person
 * measures the person.
 *
 * `since` is an ISO timestamp; only calls that returned strictly after it are
 * reported, which is what lets a caller fold a growing transcript in repeatedly
 * without counting anything twice.
 */
function readToolTimings(transcriptPath, { since = null } = {}) {
  if (!transcriptPath) return [];
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return [];
  }

  const floor = since ? Date.parse(since) : null;
  const issuedAt = new Map(); // assistant uuid -> ISO timestamp
  const toolName = new Map(); // tool_use id -> name
  const out = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;

    if (entry.type === 'assistant') {
      for (const block of content) {
        if (block && block.type === 'tool_use') {
          if (entry.uuid && entry.timestamp) issuedAt.set(entry.uuid, entry.timestamp);
          if (block.id) toolName.set(block.id, block.name || null);
        }
      }
      continue;
    }

    if (entry.type !== 'user') continue;
    for (const block of content) {
      if (!block || block.type !== 'tool_result') continue;

      const startedAt = issuedAt.get(entry.sourceToolAssistantUUID);
      const name = toolName.get(block.tool_use_id);
      if (!startedAt || !name || !entry.timestamp) continue;

      const start = Date.parse(startedAt);
      const end = Date.parse(entry.timestamp);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (floor != null && !(end > floor)) continue;

      out.push({
        name,
        toolUseId: block.tool_use_id || null,
        startedAt,
        endedAt: entry.timestamp,
        // Clamped for the same reason every elapsed in this codebase is: a clock
        // that moved backwards must not produce a negative sample that then drags
        // a percentile down.
        durationMs: Math.max(0, end - start),
      });
    }
  }

  return out;
}

module.exports = {
  entryText,
  isCommandNoise,
  isUserPromptEntry,
  looksLikeCompactSummary,
  readPromptsFromTranscript,
  readToolTimings,
};
