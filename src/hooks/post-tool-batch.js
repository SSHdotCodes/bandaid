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
const tasks = require('../lib/tasks');
const { buildCallRecords } = require('../lib/digest');
const { runHook } = require('../lib/hookio');

/**
 * How long this batch took, and — the part that keeps it honest — which way we
 * found out.
 *
 * `hook` is the payload telling us directly. `gap` is the interval since the
 * previous batch completed, which contains the model's own thinking time and is
 * therefore a *ceiling* on tool duration rather than tool duration; every
 * consumer has to segment by this field rather than average across it. `none` is
 * the first batch of a session, and carries a null duration rather than a zero —
 * a zero would be averaged into a profile and would quietly pull it down.
 *
 * The accurate per-call numbers do not come from here at all. They come from the
 * transcript, which has both ends of every call, and which cannot be read at hook
 * time because the entry for this call does not exist yet. See src/lib/durations.js.
 */
function batchTiming(input, sessionId) {
  const direct = Number(input.duration_ms ?? input.durationMs);
  if (Number.isFinite(direct) && direct >= 0) {
    const startedAt = input.started_at || input.startedAt || null;
    return { startedAt, durationMs: Math.round(direct), timing: 'hook' };
  }

  const declaredStart = input.started_at || input.startedAt || null;
  if (declaredStart && Number.isFinite(Date.parse(declaredStart))) {
    return {
      startedAt: declaredStart,
      durationMs: Math.max(0, Date.now() - Date.parse(declaredStart)),
      timing: 'hook',
    };
  }

  const previous = store.lastTurnTs(sessionId);
  const previousMs = previous ? Date.parse(previous) : NaN;
  if (!Number.isFinite(previousMs)) return { startedAt: null, durationMs: null, timing: 'none' };

  return {
    startedAt: previous,
    durationMs: Math.max(0, Date.now() - previousMs),
    timing: 'gap',
  };
}

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

  // Before digest.js flattens a task list into a 400-character label, which is
  // the only reason Bandaid has never been able to count what it asked for.
  const turnIndex = ledger.currentTurnIndex(sessionId);
  for (const call of toolCalls) {
    const name = call && call.tool_name;
    if (name !== 'TaskCreate' && name !== 'TaskUpdate' && name !== 'TodoWrite') continue;
    try {
      tasks.observe(sessionId, {
        toolName: name,
        input: call.tool_input,
        result: call.tool_response,
        turnIndex,
      });
    } catch {
      // A task ledger is an observation. Losing one must not cost the turn digest,
      // and this hook can never exit non-zero anyway.
    }
  }

  store.recordTurn(sessionId, {
    turnIndex,
    ...batchTiming(input, sessionId),
    calls,
  });
  return 0;
});
