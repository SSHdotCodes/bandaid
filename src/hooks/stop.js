#!/usr/bin/env node
'use strict';

/**
 * Stop — the goal system.
 *
 * Claude Code ends a turn whenever the model decides it is finished, and a
 * half-done task is indistinguishable from a done one. Codex instead keeps the
 * thread goal alive and re-injects a continuation prompt whose completion audit
 * treats "done" as an unproven claim.
 *
 * Exit code 2 hands stderr back to the model and continues the conversation,
 * which is how that audit is reproduced here. `stop_hook_active` and a
 * continuation cap bound it: once the budget is spent, the stop goes through.
 */

const goals = require('../lib/goals');
const ledger = require('../lib/ledger');
const store = require('../lib/store');
const { approxTokenCount } = require('../lib/tokens');
const { budgetLimitPrompt, continuationPrompt } = require('../lib/prompts');
const { emitBlocking, runHook } = require('../lib/hookio');

function estimateTokensUsed(sessionId, goal) {
  let total = 0;
  for (const turn of store.readTurns(sessionId)) {
    if (Number.isFinite(goal.turnIndex) && turn.turnIndex < goal.turnIndex) continue;
    for (const call of turn.calls || []) {
      total += approxTokenCount(call.input) + approxTokenCount(call.result);
    }
  }
  return total;
}

runHook('Stop', ({ input, config }) => {
  const sessionId = input.session_id;
  if (!store.sanitizeId(sessionId)) return 0;

  const goal = goals.loadGoal(sessionId);
  const turnIndex = ledger.currentTurnIndex(sessionId);
  const recentBatches = ledger.batchesForTurn(sessionId, turnIndex);

  const decision = goals.decideOnStop({
    goal,
    config,
    stopHookActive: Boolean(input.stop_hook_active),
    recentBatches,
    lastAssistantMessage: input.last_assistant_message || '',
  });

  if (decision.action === 'allow' || !decision.goal) return 0;

  const tokensUsed = estimateTokensUsed(sessionId, decision.goal);
  const cmd = goals.completeCommand(sessionId);

  if (decision.action === 'wrap-up') {
    // Only an explicit token budget earns the extra wrap-up turn; a spent
    // continuation cap just lets the stop through.
    if (decision.goal.tokenBudget == null) {
      goals.saveGoal(sessionId, { ...decision.goal, status: 'budget_limited', tokensUsed });
      return 0;
    }
    goals.saveGoal(sessionId, { ...decision.goal, status: 'budget_limited', tokensUsed });
    emitBlocking(budgetLimitPrompt({ ...decision.goal, tokensUsed }, { completeCommand: cmd }));
    return 2;
  }

  const updated = goals.saveGoal(sessionId, {
    ...decision.goal,
    continuations: (decision.goal.continuations || 0) + 1,
    tokensUsed,
  });

  emitBlocking(continuationPrompt(updated, { completeCommand: cmd }));
  return 2;
});
