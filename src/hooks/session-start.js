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
const store = require('../lib/store');
const { buildRestoreBlock } = require('../lib/restore');
const { blockersSection, constraintsSection } = require('../lib/prompts');
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

  if (source !== 'compact') {
    const goal = goals.loadGoal(sessionId);
    if ((source === 'resume' || source === 'fork') && goal && goal.status === 'active') {
      emit(
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
  emit(restored.text);
  return 0;
});
