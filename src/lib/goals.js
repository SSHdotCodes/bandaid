'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const project = require('./project');
const { looksLikeCorrection } = require('./restore');
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

/**
 * How many distinct blockers the model may record before the goal stops being
 * worth another continuation.
 *
 * Measured on real sessions: a goal whose remaining work needed hardware,
 * a live service, or a human click that the session did not have kept being
 * handed back for another attempt until the cap ran out — in the worst case
 * seven rounds and roughly 589k output tokens, the last three of which were
 * restatements of the same "I cannot do this here". Every one of those rounds
 * was unwinnable at the moment it started.
 */
const DEFAULT_BLOCKER_LIMIT = 2;

/** What is actually watching this goal, strongest first. */
function verifierStrength(config, goal) {
  const settings = (config && config.goals) || {};
  const check = goal && goal.check != null ? goal.check : settings.check;
  if (String(check == null ? '' : check).trim()) return 'verified';

  // Probes and expectations rank with the judge rather than above it. The
  // leash exists to bound false closes, and neither can cause one -- they veto
  // and never prove -- so they make the loop safer, not longer. An earlier
  // draft gave them a tier of their own; nobody can calibrate that number
  // against the ones already here, and an uncalibratable number is worse than
  // a wrong one because it looks principled.
  if (goal && Array.isArray(goal.expectations) && goal.expectations.length) return 'judged';
  if (goal && Array.isArray(goal.probes) && goal.probes.length) return 'judged';
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

/**
 * The commit the goal started from.
 *
 * One field, and it is the join key for everything that needs to ask "what did
 * *this work* change?" rather than "what does the repository contain?" — a diff
 * to scan for secrets, a set of paths to decide which verifiers apply, a scope
 * to enforce, a base to check out. None of it can be backfilled: by the time
 * you want the answer, the work has already happened.
 *
 * Returns null outside a git repository, which every consumer must treat as
 * "cannot tell" rather than "nothing changed".
 */
function baseSha(cwd) {
  try {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.error || result.status !== 0) return null;
    const sha = String(result.stdout || '').trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
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

function adoptCommand(sessionId) {
  return `node ${JSON.stringify(cliPath())} goal adopt --session ${sessionId}`;
}

function clearProjectCommand() {
  return `node ${JSON.stringify(cliPath())} goal clear --project`;
}

function evidenceCommand(sessionId) {
  return `node ${JSON.stringify(cliPath())} evidence add --session ${sessionId} --criterion N --pointer file.js:12 -- "what is now true"`;
}

function blockCommand(sessionId) {
  return `node ${JSON.stringify(cliPath())} goal block --session ${sessionId} "what is blocked and what would unblock it"`;
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

/**
 * The negative half of an objective: the clauses that say what must *not*
 * happen. "Migrate auth off JWT, do NOT touch the billing module" carries two
 * requirements, and only one of them is a thing to build.
 *
 * They are pulled out and stored separately because a violated constraint and
 * an unmet criterion need opposite responses. Unmet means keep working; violated
 * means stop, because a continuation cannot un-delete a directory. A real
 * session lost four consecutive stops to a judge correctly reporting that a
 * protected directory had already been deleted, which no further attempt could
 * undo.
 *
 * ponytail: clause-splitting plus the correction regex restore.js already uses
 * for compaction pinning. The upgrade path is asking the model for them at goal
 * creation the way criteria work, worth doing only if the split misses cases
 * that matter — a missed constraint costs the veto, not the goal.
 */
function extractConstraints(objective) {
  const clauses = String(objective == null ? '' : objective)
    .split(/[.;\n]+|,\s+|\s[-–—]+\s|\s+(?:but|however|while)\s+/i)
    .map((clause) => clause.replace(/\s+/g, ' ').trim());
  const seen = new Set();
  const out = [];
  for (const clause of clauses) {
    if (clause.length < 6 || !looksLikeCorrection(clause)) continue;
    if (seen.has(clause.toLowerCase())) continue;
    seen.add(clause.toLowerCase());
    out.push(clause);
  }
  return out;
}

function newGoal(
  objective,
  {
    source = 'auto',
    maxContinuations = 2,
    tokenBudget = null,
    turnIndex = 0,
    check = null,
    criteria = [],
    cwd = null,
    probes = null,
    scope = [],
  } = {},
) {
  const now = new Date().toISOString();
  const normalized = normalizeCriteria(criteria);
  return {
    objective: String(objective).trim(),
    // The commit this goal started from. See baseSha().
    baseSha: baseSha(cwd),
    // Where this goal's project lives, so every later save can record the
    // objective against the project without the caller having to carry a cwd.
    projectRoot: project.projectRoot(cwd),
    // What must not happen, kept apart from what must. See extractConstraints.
    constraints: extractConstraints(objective),
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
    // The probes armed for this goal, frozen when it was set so a manifest
    // edited mid-goal cannot retroactively move the bar. null means "not
    // frozen" — a goal that predates the manifest takes it as it stands.
    probes,
    // Paths this goal declared it would touch. Set membership where the
    // constraint regex was prose.
    scope: Array.isArray(scope) ? scope : [],
    // Predictions the model records as it works, run by the runtime at every
    // stop. See src/lib/selfcheck.js for why the timing is the whole point.
    expectations: [],
    // Work this environment cannot do, as the model reported it. Re-injected so
    // the loop stops asking, and counted so it eventually stops looping.
    blockers: [],
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
 * Record something this environment cannot do.
 *
 * The distinction the loop was missing: "not done yet" earns another turn,
 * "cannot be done from here" does not. The continuation prompt used to gate this
 * escape behind the blocker having "repeated across turns", which told the model
 * to loop at least twice before it was allowed to say it was stuck — so the
 * declaration arrived, when it arrived at all, several rounds after it was true.
 *
 * Recording a blocker does not close the goal. The rest of the objective is
 * still worth working, and a blocker the model turns out to be wrong about
 * costs one entry, not the goal.
 */
function addBlocker(sessionId, reason) {
  const goal = loadGoal(sessionId);
  if (!goal) return null;
  const text = String(reason == null ? '' : reason).replace(/\s+/g, ' ').trim();
  if (!text) return goal;

  const blockers = Array.isArray(goal.blockers) ? [...goal.blockers] : [];
  const known = blockers.some((existing) => existing.toLowerCase() === text.toLowerCase());
  if (!known) blockers.push(text);

  // A wall is worth remembering across days: without it, tomorrow's session
  // rediscovers the missing GPU at the same cost as today's did.
  if (!known && goal.projectRoot) {
    try {
      const evidence = require('./evidence');
      evidence.append(goal.projectRoot, {
        sessionId,
        objectiveHash: evidence.objectiveHash(goal.objective),
        kind: 'blocker',
        claim: text,
        verdict: 'refuted',
      });
    } catch {
      /* the ledger is never worth failing a blocker over */
    }
  }

  // A repeat still counts. Re-reporting the same blocker is the loop failing to
  // move for exactly the reason the blocker names.
  return saveGoal(sessionId, {
    ...goal,
    blockers,
    lastBlocker: text,
    blockedStreak: (goal.blockedStreak || 0) + 1,
  });
}

/** Enough of the objective is walled off that another continuation is a bad bet. */
function blockedOut(goal, config) {
  const limit = (config && config.goals && config.goals.blockerLimit) ?? DEFAULT_BLOCKER_LIMIT;
  return limit > 0 && (goal.blockedStreak || 0) >= limit;
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

/**
 * Persist the goal, and mirror it to the project it belongs to.
 *
 * The session copy is the source of truth and the only thing the hot path
 * reads. The project copy is what makes tomorrow possible: a new session can
 * find out an objective was left open here without inheriting anyone's ledger.
 */
function saveGoal(sessionId, goal) {
  const saved = store.writeGoal(sessionId, { ...goal, updatedAt: new Date().toISOString() });
  if (saved.projectRoot) {
    try {
      project.writeHandoff(saved.projectRoot, sessionId, saved);
    } catch {
      // The project record is a convenience. Losing it must never cost the
      // goal, which is already safely on disk.
    }
  }
  return saved;
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

/**
 * Take up an objective this project left open, in a session that has none.
 *
 * The bar does not move: criteria, constraints, blockers and the originating
 * commit all come across exactly as they were. What is fresh is the budget —
 * a new day earns a new continuation allowance, resolved against today's
 * config and the adopted verifier rather than yesterday's.
 *
 * Refuses when the session already has a goal. A live objective always beats a
 * remembered one.
 */
function adoptHandoff(sessionId, cwd, config, { turnIndex = 0 } = {}) {
  const record = project.readHandoff(cwd);
  if (!record || !record.goal || record.goal.status !== 'active') return null;
  if (loadGoal(sessionId)) return null;

  const carried = record.goal;
  const adopted = {
    ...newGoal(carried.objective, {
      source: carried.source || 'explicit',
      cwd,
      turnIndex,
      check: carried.check ?? null,
    }),
    criteria: carried.criteria || [],
    criteriaSource: carried.criteriaSource || null,
    constraints: carried.constraints || [],
    blockers: carried.blockers || [],
    blockedStreak: carried.blockedStreak || 0,
    // The commit the work started from, not the one it resumes at: "what has
    // this goal changed" has to span every day it ran.
    baseSha: carried.baseSha ?? null,
    createdAt: carried.createdAt,
    check: carried.check ?? null,
    adoptedFrom: record.sessionId || null,
  };
  adopted.maxContinuations = resolveMaxContinuations(config, adopted);

  return saveGoal(sessionId, adopted);
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
  DEFAULT_BLOCKER_LIMIT,
  DEFAULT_CONTINUATIONS,
  MUTATING_TOOLS,
  TERMINAL_STATUSES,
  addBlocker,
  adoptCommand,
  adoptHandoff,
  baseSha,
  blockCommand,
  blockedOut,
  clearProjectCommand,
  closeGoal,
  extractConstraints,
  completeCommand,
  criteriaCommand,
  decideOnStop,
  endsWithQuestionToUser,
  evidenceCommand,
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
