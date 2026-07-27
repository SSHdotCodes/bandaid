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
 *
 * The audit alone still asks the model to grade itself. When a check command or
 * the judge is configured, `verify.assess` runs first and outranks the model in
 * both directions: proof closes the goal without waiting to be asked, and a
 * failure blocks the stop with the actual output rather than another sermon.
 */

const goals = require('../lib/goals');
const ledger = require('../lib/ledger');
const store = require('../lib/store');
const verify = require('../lib/verify');
const { approxTokenCount } = require('../lib/tokens');
const { budgetLimitPrompt, continuationPrompt, violationPrompt } = require('../lib/prompts');
const { emitBlocking, runHook } = require('../lib/hookio');

/**
 * Turns recorded since the goal was set — the work the goal is accountable for.
 *
 * Read backwards from the end rather than parsing the whole ledger: this runs
 * on every Stop, and a multi-day session's turns.jsonl is megabytes.
 */
function turnsForGoal(sessionId, goal) {
  return store.readTurnsSince(sessionId, goal.turnIndex);
}

function estimateTokensUsed(turns) {
  let total = 0;
  for (const turn of turns) {
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

  const turns = turnsForGoal(sessionId, decision.goal);
  const tokensUsed = estimateTokensUsed(turns);
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

  // About to block. Before spending a continuation on another round of
  // self-assessment, let anything outside the model have its say.
  const assessment = verify.assess({
    goal: decision.goal,
    config,
    cwd: input.cwd,
    turns,
  });

  // Proof outranks the model in the generous direction too: a goal whose check
  // passes is finished whether or not the model got around to saying so.
  if (assessment.proven) {
    goals.saveGoal(sessionId, {
      ...decision.goal,
      status: 'complete',
      tokensUsed,
      note: assessment.reason,
    });
    return 0;
  }

  // A constraint in the objective has already been broken. Another turn cannot
  // make that untrue, so this is the last time the goal blocks — and it spends
  // that block telling the user rather than asking for a fix.
  if (assessment.violated) {
    goals.saveGoal(sessionId, {
      ...decision.goal,
      status: 'blocked',
      tokensUsed,
      note: assessment.reason,
    });
    emitBlocking(violationPrompt(decision.goal, { finding: assessment.reason }));
    return 2;
  }

  // Enough of the objective is walled off by this environment that another
  // continuation is a bad bet. Ground truth still outranks the model's own
  // account of what it cannot do: while a configured check is failing, that is
  // unfinished work with a blocker attached, not a blocked goal.
  const checkFailing = Boolean(
    assessment.verification && assessment.verification.source === 'check' && !assessment.verification.ok,
  );
  if (!checkFailing && goals.blockedOut(decision.goal, config)) {
    goals.saveGoal(sessionId, { ...decision.goal, status: 'blocked', tokensUsed });
    return 0;
  }

  const scored = goals.recordReason(decision.goal, assessment.reason);

  // Same verification failure twice running means the loop has stopped
  // converging. Another turn is a worse bet than handing it back to the user.
  if (goals.plateauReached(scored, config)) {
    goals.saveGoal(sessionId, { ...scored, status: 'budget_limited', tokensUsed });
    emitBlocking(budgetLimitPrompt({ ...scored, tokensUsed }, { completeCommand: cmd }));
    return 2;
  }

  const updated = goals.saveGoal(sessionId, {
    ...scored,
    continuations: (scored.continuations || 0) + 1,
    tokensUsed,
  });

  emitBlocking(
    continuationPrompt(updated, {
      completeCommand: cmd,
      criteriaCommand: goals.criteriaCommand(sessionId),
      blockCommand: goals.blockCommand(sessionId),
      verification: assessment.verification,
      checkCommand: updated.check ?? (config.goals || {}).check ?? null,
    }),
  );
  return 2;
});
