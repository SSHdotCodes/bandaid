#!/usr/bin/env node
'use strict';

/**
 * PostToolBatch — record the turn's mechanics.
 *
 * Fires once after every tool call in a batch has resolved, with each call's
 * input and response attached. This is the raw material for Codex-style
 * "summarize the turn with the turn itself" compaction: without it, a summary
 * can only say that work happened, not what it found.
 *
 * Must never exit 2 — on this event that aborts the agentic loop.
 */

const ledger = require('../lib/ledger');
const store = require('../lib/store');
const { buildCallRecords } = require('../lib/digest');
const { runHook } = require('../lib/hookio');

runHook('PostToolBatch', ({ input, config }) => {
  const sessionId = input.session_id;
  if (!store.sanitizeId(sessionId)) return 0;
  if (config.compact?.enabled === false || config.compact?.recordTurns === false) return 0;

  // Batch form gives us every call at once; the single-call shape is the
  // fallback if this is ever wired to PostToolUse instead.
  const toolCalls = Array.isArray(input.tool_calls)
    ? input.tool_calls
    : input.tool_name
      ? [{ tool_name: input.tool_name, tool_input: input.tool_input, tool_response: input.tool_response }]
      : [];

  if (!toolCalls.length) return 0;

  const calls = buildCallRecords(toolCalls, {
    toolInputMaxTokens: config.compact?.toolInputMaxTokens ?? 400,
    toolResultMaxTokens: config.compact?.toolResultMaxTokens ?? 900,
  });
  if (!calls.length) return 0;

  store.recordTurn(sessionId, { turnIndex: ledger.currentTurnIndex(sessionId), calls });
  return 0;
});
