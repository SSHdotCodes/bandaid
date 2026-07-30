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
const { budgetLimitPrompt, continuationPrompt, probePendingPrompt, violationPrompt } = require('../lib/prompts');
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

/**
 * How each criterion actually stands, according to the ledger rather than the
 * model. Empty when the goal has no criteria or no project to record against,
 * which is also what keeps the injected prompt byte-identical for anyone who
 * has not turned any of this on.
 */
function evidenceSummaryFor(goal) {
  if (!goal.projectRoot || !(goal.criteria || []).length) return '';
  try {
    const evidence = require('../lib/evidence');
    const { worktreeStamp } = require('../lib/stamp');
    const entries = evidence.read(goal.projectRoot, { objectiveHash: evidence.objectiveHash(goal.objective) });
    return evidence.summarize(entries, goal.criteria.length, worktreeStamp(goal.projectRoot));
  } catch {
    return '';
  }
}

/**
 * The wall-clock budget in force for this goal: its own, or the configured
 * default. Resolved in one place because three call sites need to agree on it,
 * which is the same reason `check` is resolved as `goal.check ?? config`.
 */
function resolvedTimeBudget(goal, config) {
  return goal.timeBudgetMs ?? (config.goals || {}).timeBudgetMs ?? null;
}

/**
 * How much longer this looks like taking, or null.
 *
 * Built from the task ledger and criteria coverage — both already computed
 * elsewhere in this hook's work, neither of them the model's word for anything.
 * Wrapped because an estimate is a nicety: a broken one must not cost a stop.
 */
function estimateRemaining(sessionId, goal) {
  try {
    const eta = require('../lib/eta');
    return eta.estimate(goal, { taskState: taskStateFor(sessionId), coverage: coverageFor(goal) });
  } catch {
    return null;
  }
}

/** The task ledger's state, or null. Never throws: it is an observation. */
function taskStateFor(sessionId) {
  try {
    return require('../lib/tasks').state(sessionId);
  } catch {
    return null;
  }
}

/** Criteria coverage from the project ledger, in the shape eta.js expects. */
function coverageFor(goal) {
  if (!goal.projectRoot || !(goal.criteria || []).length) return null;
  try {
    const evidence = require('../lib/evidence');
    const { worktreeStamp } = require('../lib/stamp');
    return evidence.coverage(
      evidence.read(goal.projectRoot, { objectiveHash: evidence.objectiveHash(goal.objective) }),
      goal.criteria.length,
      worktreeStamp(goal.projectRoot),
    );
  } catch {
    return null;
  }
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

  // Read the clock once. Every elapsed figure in this hook's output derives from
  // it, so a slow verification cannot make one line disagree with another.
  const now = Date.now();

  const goal = goals.loadGoal(sessionId);

  // Fold the transcript's real per-call durations into this project's profile.
  // Stop is the first moment the entries for this turn's calls exist. It never
  // throws and its result is not read here — a profile is a nicety, and a broken
  // one must not cost a stop.
  if (goal && goal.projectRoot) {
    require('../lib/durations').sync(goal.projectRoot, input.transcript_path);
  }

  const turnIndex = ledger.currentTurnIndex(sessionId);
  const recentBatches = ledger.batchesForTurn(sessionId, turnIndex);

  const decision = goals.decideOnStop({
    goal,
    config,
    stopHookActive: Boolean(input.stop_hook_active),
    recentBatches,
    lastAssistantMessage: input.last_assistant_message || '',
    now,
  });

  if (decision.action === 'allow' || !decision.goal) return 0;

  const turns = turnsForGoal(sessionId, decision.goal);
  const tokensUsed = estimateTokensUsed(turns);
  const cmd = goals.completeCommand(sessionId);

  if (decision.action === 'wrap-up') {
    // Only an explicit budget earns the extra wrap-up turn; a spent continuation
    // cap just lets the stop through. A wall-clock budget counts as explicit for
    // the same reason a token budget does — somebody set a number and deserves
    // to be told it ran out.
    const explicitBudget =
      decision.goal.tokenBudget != null || resolvedTimeBudget(decision.goal, config) != null;
    goals.saveGoal(sessionId, { ...decision.goal, status: 'budget_limited', tokensUsed });
    if (!explicitBudget) return 0;
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
    // Every verdict from here is written to the project's evidence ledger, so
    // tomorrow's judge knows what today's already established.
    record: true,
  });

  // Proof outranks the model in the generous direction too: a goal whose check
  // passes is finished whether or not the model got around to saying so.
  if (assessment.proven) {
    // Unless something is still measuring. A probe launched this turn has no
    // verdict yet; it cannot veto, or every first stop after an edit would
    // block — but letting the goal close before it reports would throw the
    // answer away. So the close is held, once, and not at the cost of a
    // continuation.
    const pending = (assessment.probes && assessment.probes.pending) || [];
    const maxDefers = (config.probes || {}).maxDefers ?? 3;
    const defers = decision.goal.defers || 0;

    if (pending.length && defers < maxDefers) {
      goals.saveGoal(sessionId, { ...decision.goal, defers: defers + 1, tokensUsed });
      emitBlocking(
        probePendingPrompt(decision.goal, {
          pending,
          defer: defers + 1,
          maxDefers,
        }),
      );
      return 2;
    }

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

  // Did this round move the work, or only touch it? Anything the model can fake by
  // editing a file does not count — see src/lib/progress.js for the ordering.
  const progress = require('../lib/progress');
  const coverage = coverageFor(decision.goal);
  const taskState = taskStateFor(sessionId);
  const verdict = progress.detect({
    goal: decision.goal,
    coverage,
    taskState,
    reason: assessment.reason,
  });

  const updated = goals.saveGoal(sessionId, {
    ...goals.recordContinuation(scored, now),
    ...progress.settle({ goal: scored, ...verdict, now }),
    // Snapshot what the next round compares against. Taken after settle so it
    // cannot be read as this round's progress on the next one.
    coveredCount: progress.coveredCount(coverage),
    completedTasks: taskState ? taskState.completed : null,
    tokensUsed,
  });

  emitBlocking(
    continuationPrompt(updated, {
      now,
      timeBudgetMs: resolvedTimeBudget(updated, config),
      eta: estimateRemaining(sessionId, updated),
      askedPermission: Boolean(decision.askedPermission),
      // Empty in every real run; eval/loop.js sets it to measure whether a block
      // earns its tokens.
      ablate: config.ablate || [],
      completeCommand: cmd,
      criteriaCommand: goals.criteriaCommand(sessionId),
      blockCommand: goals.blockCommand(sessionId),
      evidenceCommand: updated.projectRoot ? goals.evidenceCommand(sessionId) : null,
      // One line, computed by the runtime, where the audit otherwise asks the
      // model to grade its own criteria one at a time and take its own word.
      evidenceSummary: evidenceSummaryFor(updated),
      verification: assessment.verification,
      checkCommand: updated.check ?? (config.goals || {}).check ?? null,
    }),
  );
  return 2;
});
