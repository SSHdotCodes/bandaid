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

/**
 * Karpathy's autonomy slider: "slide autonomy up as the verifier proves out."
 *
 * A single cap is wrong in both directions at once. Two continuations is
 * generous for a goal nothing can check — that is two extra rounds of work
 * graded by the model that did it. It is miserly for a goal with a shell check,
 * where the thing deciding when to stop is an exit status and the count is only
 * a backstop against a wedged loop.
 */
const DEFAULT_CONTINUATIONS = { verified: 8, judged: 4, unverified: 2 };

/** What is actually watching this goal, strongest first. */
function verifierStrength(config, goal) {
  const settings = (config && config.goals) || {};
  const check = goal && goal.check != null ? goal.check : settings.check;
  if (String(check == null ? '' : check).trim()) return 'verified';
  if (settings.judge === true) return 'judged';
  return 'unverified';
}

/**
 * Resolve the continuation cap for a goal. A scalar `maxContinuations` in
 * config is a deliberate override and wins outright, which is what every
 * config written before the slider existed looks like.
 */
function resolveMaxContinuations(config, goal = null) {
  const configured = ((config && config.goals) || {}).maxContinuations;
  if (typeof configured === 'number') return configured;
  const tiers = { ...DEFAULT_CONTINUATIONS, ...(configured || {}) };
  const resolved = tiers[verifierStrength(config, goal)];
  return typeof resolved === 'number' ? resolved : DEFAULT_CONTINUATIONS.unverified;
}

function cliPath() {
  return path.join(__dirname, '..', '..', 'bin', 'bandaid.js');
}

function completeCommand(sessionId) {
  return `node ${JSON.stringify(cliPath())} goal complete --session ${sessionId}`;
}

function criteriaCommand(sessionId) {
  return `node ${JSON.stringify(cliPath())} goal criteria --session ${sessionId} "first" "second"`;
}

/** Criteria are data, not prose: trimmed, de-duplicated, empties dropped. */
function normalizeCriteria(criteria) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(criteria) ? criteria : []) {
    const text = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
  }
  return out;
}

function newGoal(
  objective,
  { source = 'auto', maxContinuations = 2, tokenBudget = null, turnIndex = 0, check = null, criteria = [] } = {},
) {
  const now = new Date().toISOString();
  const normalized = normalizeCriteria(criteria);
  return {
    objective: String(objective).trim(),
    // What "done" means, fixed once and re-injected verbatim every turn.
    //
    // Without this the requirements are re-derived from prose on every
    // continuation, which is where scope quietly shrinks, and the judge derives
    // its own reading independently — so worker and judge are graded on two
    // rubrics that only accidentally agree.
    criteria: normalized,
    criteriaSource: normalized.length ? source : null,
    status: 'active',
    source,
    createdAt: now,
    updatedAt: now,
    continuations: 0,
    maxContinuations,
    tokenBudget,
    tokensUsed: 0,
    turnIndex,
    // Shell command that proves this objective is done, or null to fall back to
    // the configured default. Exit 0 is the only thing that closes a goal
    // without the model's say-so.
    check,
    blockedStreak: 0,
    lastBlocker: null,
    // Verification reason from the previous stop, and how many stops in a row
    // have now produced that same reason.
    lastReason: null,
    plateau: 0,
    note: null,
  };
}

/**
 * Two failures are "the same" if the text is the same once whitespace and case
 * stop mattering. Digits are deliberately significant: "3 tests failing" and
 * "1 test failing" are progress, and progress is not a plateau.
 */
function normalizeReason(reason) {
  return String(reason == null ? '' : reason)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fold a verification reason into the goal, counting consecutive repeats.
 *
 * This is the guard neither Codex nor Claude Code has. Both bound the loop by
 * budget, which cannot tell "two more turns and it lands" from "the same test
 * has failed the same way three times". Identical evidence twice running means
 * the loop has stopped converging, and another turn is a worse bet than
 * handing the problem back to the user.
 */
function recordReason(goal, reason) {
  if (!reason) return { ...goal, plateau: 0 };
  const repeated = normalizeReason(reason) === normalizeReason(goal.lastReason) && Boolean(goal.lastReason);
  return { ...goal, lastReason: reason, plateau: repeated ? (goal.plateau || 0) + 1 : 0 };
}

function plateauReached(goal, config) {
  const limit = (config && config.goals && config.goals.plateauLimit) ?? 2;
  return limit > 0 && (goal.plateau || 0) >= limit;
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

/**
 * Record the bar for an existing goal. Auto-mode goals are created by a hook
 * with no model in the loop, so this is how the default mode ever acquires
 * criteria at all.
 *
 * Deliberately not idempotent-by-overwrite: criteria set once are the fixed
 * rubric, and letting a later turn rewrite them would reintroduce exactly the
 * drift they exist to prevent. Pass `{ replace: true }` to mean it.
 */
function setCriteria(sessionId, criteria, { source = 'model', replace = false } = {}) {
  const goal = loadGoal(sessionId);
  if (!goal) return null;
  const normalized = normalizeCriteria(criteria);
  if (!normalized.length) return goal;
  if (!replace && (goal.criteria || []).length) return goal;
  return saveGoal(sessionId, { ...goal, criteria: normalized, criteriaSource: source });
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

  const max = goal.maxContinuations == null ? resolveMaxContinuations(config, goal) : goal.maxContinuations;
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
  DEFAULT_CONTINUATIONS,
  MUTATING_TOOLS,
  TERMINAL_STATUSES,
  closeGoal,
  completeCommand,
  criteriaCommand,
  decideOnStop,
  endsWithQuestionToUser,
  isGoalWorthy,
  loadGoal,
  newGoal,
  normalizeCriteria,
  normalizeReason,
  plateauReached,
  recordReason,
  resolveMaxContinuations,
  saveGoal,
  setCriteria,
  setGoal,
  turnWasTrivial,
  verifierStrength,
};
