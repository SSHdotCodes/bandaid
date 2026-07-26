'use strict';

const path = require('node:path');

const store = require('./store');

/**
 * Goal state machine.
 *
 * Claude Code has no notion of an objective that outlives a turn: when the
 * model decides it is done, the turn ends, and a half-finished task looks
 * exactly like a finished one. Codex keeps a thread goal alive across turns and
 * re-injects a continuation prompt with a completion audit until the model can
 * prove the objective is met.
 *
 * Bandaid reproduces that with the Stop hook, which can exit 2 to hand feedback
 * back to the model and keep the conversation going. The continuation count is
 * bounded so a goal the model cannot finish degrades into a normal stop rather
 * than an infinite loop.
 */

const MUTATING_TOOLS = new Set([
  'Bash',
  'Edit',
  'NotebookEdit',
  'Write',
  'Task',
  'Agent',
  'Workflow',
  'MultiEdit',
]);

const TERMINAL_STATUSES = new Set(['complete', 'blocked', 'budget_limited', 'abandoned']);

function completeCommand(sessionId) {
  const cli = path.join(__dirname, '..', '..', 'bin', 'bandaid.js');
  return `node ${JSON.stringify(cli)} goal complete --session ${sessionId}`;
}

function newGoal(objective, { source = 'auto', maxContinuations = 2, tokenBudget = null, turnIndex = 0 } = {}) {
  const now = new Date().toISOString();
  return {
    objective: String(objective).trim(),
    status: 'active',
    source,
    createdAt: now,
    updatedAt: now,
    continuations: 0,
    maxContinuations,
    tokenBudget,
    tokensUsed: 0,
    turnIndex,
    blockedStreak: 0,
    lastBlocker: null,
    note: null,
  };
}

/**
 * Prompts that are plainly not objectives. Turning "thanks" into a goal that
 * blocks the stop hook would be worse than not having a goal system at all.
 */
function isGoalWorthy(text) {
  const trimmed = String(text || '').trim();
  if (trimmed.length < 12) return false;
  if (trimmed.startsWith('<')) return false;

  const lowered = trimmed.toLowerCase();
  const chatter = [
    'thanks',
    'thank you',
    'ty',
    'ok',
    'okay',
    'nice',
    'cool',
    'great',
    'perfect',
    'yes',
    'no',
    'yep',
    'nope',
    'continue',
    'go on',
    'stop',
    'nevermind',
    'never mind',
  ];
  if (chatter.includes(lowered.replace(/[!.?]+$/, ''))) return false;

  return true;
}

/** A turn that touched nothing is not the kind of turn a completion audit helps. */
function turnWasTrivial(batches) {
  for (const batch of batches || []) {
    for (const call of batch.calls || []) {
      if (MUTATING_TOOLS.has(call.name)) return false;
    }
  }
  return true;
}

function loadGoal(sessionId) {
  const goal = store.readGoal(sessionId);
  if (!goal || typeof goal !== 'object' || !goal.objective) return null;
  return goal;
}

function saveGoal(sessionId, goal) {
  return store.writeGoal(sessionId, { ...goal, updatedAt: new Date().toISOString() });
}

function setGoal(sessionId, objective, opts = {}) {
  const goal = newGoal(objective, opts);
  return saveGoal(sessionId, goal);
}

function closeGoal(sessionId, status, note = null) {
  const goal = loadGoal(sessionId);
  if (!goal) return null;
  return saveGoal(sessionId, { ...goal, status, note });
}

/**
 * Claude legitimately ends a turn to ask the user something. Blocking that would
 * trap the user in a loop where the question is never actually asked, so a
 * trailing question mark always wins over the continuation.
 */
function endsWithQuestionToUser(message) {
  const text = String(message || '').trim();
  if (!text) return false;
  const tail = text.slice(-400);
  // Ignore fenced code and tables, where a '?' is not the model addressing anyone.
  const lastLine = tail.split('\n').filter((line) => line.trim()).pop() || '';
  return lastLine.trim().endsWith('?');
}

/**
 * Decide whether the Stop hook should block. Returns
 * `{ action: 'allow' | 'continue' | 'wrap-up', goal, reason }`.
 */
function decideOnStop({ goal, config, stopHookActive, recentBatches, lastAssistantMessage = '' }) {
  const goals = config.goals || {};

  if (!config.enabled || goals.enabled === false || goals.mode === 'off') {
    return { action: 'allow', goal, reason: 'goals disabled' };
  }
  // Claude Code sets this once a Stop hook has already blocked; honoring it is
  // what keeps a stubborn goal from becoming an infinite loop.
  if (stopHookActive) return { action: 'allow', goal, reason: 'stop_hook_active' };
  if (!goal) return { action: 'allow', goal, reason: 'no active goal' };
  if (TERMINAL_STATUSES.has(goal.status)) return { action: 'allow', goal, reason: `goal ${goal.status}` };
  if (goal.status !== 'active') return { action: 'allow', goal, reason: `goal status ${goal.status}` };

  const max = goal.maxContinuations == null ? (goals.maxContinuations ?? 2) : goal.maxContinuations;
  if (max <= 0) return { action: 'allow', goal, reason: 'continuations disabled' };

  if (goal.continuations >= max) {
    return { action: 'wrap-up', goal, reason: `continuation budget exhausted (${goal.continuations}/${max})` };
  }

  if (goal.tokenBudget != null && goal.tokensUsed >= goal.tokenBudget) {
    return { action: 'wrap-up', goal, reason: 'token budget exhausted' };
  }

  if (endsWithQuestionToUser(lastAssistantMessage)) {
    return { action: 'allow', goal, reason: 'model is asking the user a question' };
  }

  if (goals.skipTrivialTurns !== false && turnWasTrivial(recentBatches)) {
    return { action: 'allow', goal, reason: 'turn changed nothing' };
  }

  return { action: 'continue', goal, reason: `continuation ${goal.continuations + 1}/${max}` };
}

module.exports = {
  MUTATING_TOOLS,
  TERMINAL_STATUSES,
  closeGoal,
  completeCommand,
  decideOnStop,
  endsWithQuestionToUser,
  isGoalWorthy,
  loadGoal,
  newGoal,
  saveGoal,
  setGoal,
  turnWasTrivial,
};
