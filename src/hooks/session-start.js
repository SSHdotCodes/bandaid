#!/usr/bin/env node
'use strict';

/**
 * SessionStart — rebuild the context Claude Code threw away.
 *
 * Fires with `source: "compact"` immediately after a compaction, and its stdout
 * goes to the model. That makes it the injection point for Codex's
 * post-compaction history shape: every user message verbatim under a
 * 20k-token budget, plus the per-turn tool digests, ahead of the summary.
 *
 * Also fires on `resume` and `fork`, where the goal is simply to reattach the
 * ledger and remind the model of an objective that is still open.
 */

const goals = require('../lib/goals');
const ledger = require('../lib/ledger');
const project = require('../lib/project');
const store = require('../lib/store');
const { buildRestoreBlock } = require('../lib/restore');
const { blockersSection, constraintsSection, openObjectivePrompt, sessionClockLine } = require('../lib/prompts');
const { emit, runHook } = require('../lib/hookio');

/**
 * Drop session directories nothing will read again, at most once a day.
 *
 * SessionStart is the right place: it is the one hook that fires when nothing
 * is waiting on it, and its budget is 30s rather than the 10s the per-turn
 * hooks get. Failures are swallowed — a sweep that cannot run is untidiness,
 * not a reason to cost the user a session.
 */
function sweepIfDue(config) {
  const retention = config.retention || {};
  if (retention.enabled === false) return;

  const intervalMs = (retention.sweepIntervalHours ?? 24) * 60 * 60 * 1000;
  const last = Date.parse(store.readState().lastSweepAt || '') || 0;
  if (Date.now() - last < intervalMs) return;

  try {
    store.updateState({ lastSweepAt: new Date().toISOString() });
    store.pruneSessions({
      maxAgeDays: retention.sessionMaxAgeDays ?? 30,
      maxCount: retention.sessionMaxCount ?? 200,
    });
  } catch {
    /* nothing here is worth failing a session over */
  }
}

/**
 * Surface an objective this project left open, if there is one and policy says
 * to. Returns true when it emitted something, so the caller can stop.
 *
 * "offer" arms nothing: the block names the objective and the one command that
 * takes it up, and says plainly that no stop will be blocked until it is. That
 * is the default because force-feeding an objective into an unrelated session
 * is the worse error, and a model told the facts will decide better than a
 * policy can.
 */
/**
 * The clock, as a prefix for whatever this hook was already going to say.
 *
 * Deliberately *not* an emit of its own. A startup session with no objective to
 * offer and no compaction to restore injects nothing at all — three end-to-end
 * tests assert exactly that, and they are defending the property the whole
 * design rests on: no tokens until something needs them. So the time rides along
 * with a block that was already being paid for, and a session with nothing to say
 * still says nothing.
 */
function clockPrefix(config, sessionId) {
  const line = sessionClockLine({
    sessionStartedAt: store.sessionStartedAt(sessionId),
    goal: goals.loadGoal(sessionId),
    timeBudgetMs: (config.goals || {}).timeBudgetMs ?? null,
  });
  return line ? `[Bandaid] ${line}\n\n` : '';
}

function carryOver(config, sessionId, cwd, clock = '') {
  const settings = config.goals || {};
  if (!config.enabled || settings.enabled === false || settings.mode === 'off') return false;

  const mode = settings.carryOver || 'offer';
  if (mode === 'off') return false;

  const record = project.readHandoff(cwd);
  if (!record || !record.goal || record.goal.status !== 'active') return false;

  const ageDays = project.ageInDays(record.updatedAt);

  if (mode === 'auto') {
    const adopted = goals.adoptHandoff(sessionId, cwd, config);
    if (!adopted) return false;
    emit(clock + openObjectivePrompt(record, { adopted: true, ageDays }));
    return true;
  }

  emit(
    clock +
      openObjectivePrompt(record, {
        adopted: false,
        adoptCommand: goals.adoptCommand(sessionId),
        clearCommand: goals.clearProjectCommand(),
        ageDays,
      }),
  );
  return true;
}

runHook('SessionStart', ({ input, config }) => {
  const sessionId = input.session_id;
  if (!store.sanitizeId(sessionId)) return 0;

  const source = input.source || 'startup';
  const cwd = input.cwd || process.cwd();

  sweepIfDue(config);

  // Capture who was driving this directory before we claim it, so a fork still
  // knows which ledger to inherit.
  const previousSessionId = store.getCurrentSession(cwd);
  store.setCurrentSession(sessionId, cwd);

  if (source === 'clear') {
    // A cleared conversation should not drag an old objective into the new one.
    // The project record survives on purpose: deleting a multi-day objective
    // because someone cleared their scrollback is data loss, and `goal clear
    // --project` is the way to mean it.
    store.clearGoal(sessionId);
    store.updateMeta(sessionId, { pendingRestore: false });
    return 0;
  }

  if (source === 'resume' || source === 'fork') {
    // Only a resume or a fork continues an earlier conversation. A fresh
    // `startup` in the same directory must not inherit the last session's
    // ledger, or it would replay someone else's instructions after a compaction.
    ledger.adoptPreviousLedger(sessionId, cwd, previousSessionId);
  }

  if (source === 'resume' || source === 'fork' || source === 'startup') {
    ledger.backfillFromTranscript(sessionId, input.transcript_path);
  }

  const clock = clockPrefix(config, sessionId);

  if (source !== 'compact') {
    const goal = goals.loadGoal(sessionId);

    // Nothing carried through the ledger, but this project has an objective
    // that was never closed. Offer it, or take it up, depending on policy —
    // never silently, because a session that starts working yesterday's task
    // because it saw the words is worse than one that never heard of it.
    if (!goal && carryOver(config, sessionId, cwd, clock)) return 0;

    if ((source === 'resume' || source === 'fork') && goal && goal.status === 'active') {
      emit(
        clock +
        [
          '<bandaid-active-goal>',
          'This objective was still open when the session was last active:',
          '',
          goal.objective,
          ...((goal.criteria || []).length
            ? ['', 'It is done when all of these are true, and not before:', ...goal.criteria.map((t, i) => `${i + 1}. ${t}`)]
            : []),
          // The negative half and the walls travel with the objective. A resumed
          // session that remembers only what to build re-attempts work already
          // recorded as impossible, and breaks the one thing it was told to
          // leave alone. Both sections render to '' when there is nothing to
          // say, so they are spread rather than pushed.
          ...(constraintsSection(goal) ? [constraintsSection(goal).trimEnd()] : []),
          ...(blockersSection(goal) ? [blockersSection(goal).trimEnd()] : []),
          '',
          'Verify current state before assuming any of it is already done.',
          '</bandaid-active-goal>',
        ].join('\n'),
      );
    }
    return 0;
  }

  if (config.compact?.enabled === false) return 0;

  const prompts = store.readPrompts(sessionId);
  const batches = store.readTurns(sessionId);
  const goal = goals.loadGoal(sessionId);

  const restored = buildRestoreBlock({ prompts, batches, config, goal });
  if (!restored) return 0;

  store.updateMeta(sessionId, { pendingRestore: false, lastRestoreStats: restored.stats });
  emit(clock + restored.text);
  return 0;
});
