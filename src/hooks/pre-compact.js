#!/usr/bin/env node
'use strict';

/**
 * PreCompact — replace Claude Code's summarization directive.
 *
 * Claude Code appends this hook's stdout to the compaction prompt as custom
 * instructions, which is the supported way to change what the summarizer is
 * told to produce. We hand it Codex's CONTEXT CHECKPOINT COMPACTION prompt plus
 * the fidelity rules that keep tool parameters, results, and exact identifiers
 * in the summary instead of prose about them.
 *
 * This is also the last moment the pre-compaction transcript exists, so it is
 * where the ledger is topped up.
 */

const ledger = require('../lib/ledger');
const store = require('../lib/store');
const { COMPACTION_FIDELITY_ADDENDUM, SUMMARIZATION_PROMPT } = require('../lib/prompts');
const { emit, runHook } = require('../lib/hookio');

runHook('PreCompact', ({ input, config }) => {
  const sessionId = input.session_id;

  if (store.sanitizeId(sessionId)) {
    const cwd = input.cwd || process.cwd();
    store.setCurrentSession(sessionId, cwd);
    try {
      ledger.backfillFromTranscript(sessionId, input.transcript_path);
    } catch {
      // Backfill is best-effort; never block a compaction over it.
    }
    store.updateMeta(sessionId, {
      pendingRestore: true,
      lastCompactTrigger: input.trigger || 'auto',
      lastCompactAt: new Date().toISOString(),
    });
  }

  if (config.compact?.enabled === false || config.compact?.useCodexSummaryPrompt === false) return 0;

  const sections = [SUMMARIZATION_PROMPT, COMPACTION_FIDELITY_ADDENDUM];

  // A manual `/compact <instructions>` must still win over ours.
  const custom = typeof input.custom_instructions === 'string' ? input.custom_instructions.trim() : '';
  if (custom) sections.push(`The user additionally asked for:\n${custom}`);

  emit(sections.join('\n\n'));
  return 0;
});
