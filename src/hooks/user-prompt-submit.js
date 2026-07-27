#!/usr/bin/env node
'use strict';

/**
 * UserPromptSubmit — capture the prompt verbatim, open the turn, set the goal.
 *
 * Emits nothing to the model: the ledger is written to disk and costs zero
 * tokens until a compaction actually needs it.
 */

const goals = require('../lib/goals');
const ledger = require('../lib/ledger');
const store = require('../lib/store');
const { runHook } = require('../lib/hookio');

runHook('UserPromptSubmit', ({ input, config }) => {
  const sessionId = input.session_id;
  if (!store.sanitizeId(sessionId)) return 0;

  const cwd = input.cwd || process.cwd();
  store.setCurrentSession(sessionId, cwd);

  const prompt = typeof input.prompt === 'string' ? input.prompt : '';

  if (config.compact?.enabled !== false) {
    // Backfill before recording so ordering and turn numbers line up. Adoption
    // of a previous session's ledger belongs to SessionStart, which is the only
    // place that knows whether this is a resume or a genuinely new conversation.
    ledger.backfillFromTranscript(sessionId, input.transcript_path);

    if (prompt.trim()) {
      store.recordPrompt(sessionId, { text: prompt, promptId: input.prompt_id || null, cwd });
    }
  }

  const turnIndex = ledger.bumpTurnIndex(sessionId);

  const goalConfig = config.goals || {};
  if (goalConfig.enabled !== false && goalConfig.mode === 'auto' && goals.isGoalWorthy(prompt)) {
    const check = goalConfig.check ?? null;
    goals.setGoal(sessionId, prompt, {
      source: 'auto',
      // Resolved against the goal this is about to become, not against config
      // alone. Today that only matters for the configured check; it is the seam
      // a per-goal verifier resolves through.
      maxContinuations: goals.resolveMaxContinuations(config, { check }),
      tokenBudget: goalConfig.tokenBudget ?? null,
      turnIndex,
      cwd,
    });
  } else {
    // A new prompt during an explicit goal resets its continuation budget so a
    // long session does not inherit an exhausted counter.
    const existing = goals.loadGoal(sessionId);
    if (existing && existing.status === 'active') {
      goals.saveGoal(sessionId, { ...existing, continuations: 0 });
    }
  }

  return 0;
});
