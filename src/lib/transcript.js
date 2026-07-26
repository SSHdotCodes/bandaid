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

module.exports = { entryText, isCommandNoise, isUserPromptEntry, looksLikeCompactSummary, readPromptsFromTranscript };
