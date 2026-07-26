#!/usr/bin/env node
'use strict';

/**
 * PostCompact — report what survived.
 *
 * Its stdout is shown to the user, not the model, so this is purely the receipt:
 * how much was preserved verbatim and how much fell outside the budget. The
 * summary itself is archived for `bandaid inspect`.
 */

const path = require('node:path');

const store = require('../lib/store');
const { emit, runHook } = require('../lib/hookio');

runHook('PostCompact', ({ input, config }) => {
  const sessionId = input.session_id;
  if (!store.sanitizeId(sessionId)) return 0;
  if (config.compact?.enabled === false) return 0;

  // Claude Code sends the summary as `compact_summary`; `summary` is a fallback
  // in case that field name ever changes back.
  const summary =
    typeof input.compact_summary === 'string'
      ? input.compact_summary
      : typeof input.summary === 'string'
        ? input.summary
        : '';
  if (summary) {
    try {
      store.appendJsonl(path.join(store.sessionDir(sessionId), 'summaries.jsonl'), {
        ts: new Date().toISOString(),
        trigger: input.trigger || 'auto',
        summary,
      });
    } catch {
      // Archiving is a convenience, not a requirement.
    }
  }

  const stats = store.readMeta(sessionId).lastRestoreStats;
  if (!stats) return 0;

  const parts = [
    `bandaid: restored ${stats.promptsKept} user message${stats.promptsKept === 1 ? '' : 's'} verbatim`,
  ];
  if (stats.turnsKept) parts.push(`${stats.turnsKept} turn digest${stats.turnsKept === 1 ? '' : 's'}`);
  parts.push(`~${stats.totalTokens} tokens`);
  if (stats.promptsDropped) parts.push(`${stats.promptsDropped} older message(s) over budget`);

  emit(parts.join(' · '));
  return 0;
});
