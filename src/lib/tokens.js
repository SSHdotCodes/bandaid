'use strict';

/**
 * Token estimation and middle-out truncation.
 *
 * Direct port of Codex's `codex-rs/utils/string/src/truncate.rs` so that
 * Bandaid's budgeting math matches Codex's byte-for-byte. Codex approximates
 * one token as four UTF-8 bytes and truncates the *middle* of a string,
 * preserving both the head and the tail, because the start of a message
 * carries intent and the end carries the most recent state.
 */

const APPROX_BYTES_PER_TOKEN = 4;

function byteLen(str) {
  return Buffer.byteLength(str == null ? '' : String(str), 'utf8');
}

/** ceil(bytes / 4) — Codex's `approx_token_count`. */
function approxTokenCount(text) {
  return Math.ceil(byteLen(text) / APPROX_BYTES_PER_TOKEN);
}

function approxBytesForTokens(tokens) {
  return Math.max(0, Math.floor(tokens)) * APPROX_BYTES_PER_TOKEN;
}

function approxTokensFromByteCount(bytes) {
  return Math.ceil(Math.max(0, bytes) / APPROX_BYTES_PER_TOKEN);
}

/** Codex splits an even budget so the tail keeps the odd byte. */
function splitBudget(budget) {
  const left = Math.floor(budget / 2);
  return [left, budget - left];
}

/**
 * Walk code points once, collecting a byte-bounded prefix and suffix while
 * counting the characters dropped in between. Mirrors Codex's `split_string`.
 */
function splitString(str, beginningBytes, endBytes) {
  if (!str) return [0, '', ''];

  const total = byteLen(str);
  const tailStartTarget = Math.max(0, total - endBytes);

  let prefixEnd = 0;
  let suffixStart = total;
  let removedChars = 0;
  let suffixStarted = false;
  let idx = 0;

  for (const ch of str) {
    const charEnd = idx + byteLen(ch);
    if (charEnd <= beginningBytes) {
      prefixEnd = charEnd;
    } else if (idx >= tailStartTarget) {
      if (!suffixStarted) {
        suffixStart = idx;
        suffixStarted = true;
      }
    } else {
      removedChars += 1;
    }
    idx = charEnd;
  }

  if (suffixStart < prefixEnd) suffixStart = prefixEnd;

  const buf = Buffer.from(str, 'utf8');
  return [removedChars, buf.subarray(0, prefixEnd).toString('utf8'), buf.subarray(suffixStart).toString('utf8')];
}

function formatTruncationMarker(useTokens, removedCount) {
  return useTokens ? `…${removedCount} tokens truncated…` : `…${removedCount} chars truncated…`;
}

function removedUnits(useTokens, removedBytes, removedChars) {
  return useTokens ? approxTokensFromByteCount(removedBytes) : removedChars;
}

function truncateWithByteEstimate(str, maxBytes, useTokens) {
  if (!str) return '';

  const totalBytes = byteLen(str);
  if (maxBytes === 0) {
    return formatTruncationMarker(useTokens, removedUnits(useTokens, totalBytes, [...str].length));
  }
  if (totalBytes <= maxBytes) return str;

  const [left, right] = splitBudget(maxBytes);
  const [removedChars, before, after] = splitString(str, left, right);
  const marker = formatTruncationMarker(
    useTokens,
    removedUnits(useTokens, Math.max(0, totalBytes - maxBytes), removedChars),
  );
  return before + marker + after;
}

/**
 * Truncate to at most `maxTokens` approximate tokens, keeping head and tail.
 * Returns `{ text, originalTokens }`; `originalTokens` is null when the input
 * fit within budget and was returned untouched.
 */
function truncateMiddleWithTokenBudget(str, maxTokens) {
  if (!str) return { text: '', originalTokens: null };

  if (maxTokens > 0 && byteLen(str) <= approxBytesForTokens(maxTokens)) {
    return { text: str, originalTokens: null };
  }

  const text = truncateWithByteEstimate(str, approxBytesForTokens(maxTokens), true);
  return text === str ? { text, originalTokens: null } : { text, originalTokens: approxTokenCount(str) };
}

function truncateMiddleChars(str, maxBytes) {
  return truncateWithByteEstimate(str, maxBytes, false);
}

module.exports = {
  APPROX_BYTES_PER_TOKEN,
  approxBytesForTokens,
  approxTokenCount,
  approxTokensFromByteCount,
  byteLen,
  splitBudget,
  splitString,
  truncateMiddleChars,
  truncateMiddleWithTokenBudget,
};
