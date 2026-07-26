'use strict';

const { groupBatchesByTurn, renderTurnDigest } = require('./digest');
const { RESTORE_FRAMING } = require('./prompts');
const { approxTokenCount, truncateMiddleWithTokenBudget } = require('./tokens');

/**
 * Post-compaction context restoration.
 *
 * This is the piece Claude Code has no equivalent of. Codex builds its
 * post-compaction history as:
 *
 *     [initial context] + [user messages, verbatim, newest-first under a
 *                          20k-token budget] + [summary]
 *
 * so the user's own words are never summarized away — only the model's
 * reasoning is. Claude Code instead replaces everything with a summary, so the
 * exact wording of your instructions, constraints, and corrections is gone.
 *
 * Bandaid rebuilds that structure from the ledger and injects it through the
 * SessionStart(source=compact) hook, which runs after compaction and whose
 * stdout goes to the model.
 */

/**
 * Codex's `build_compacted_history_with_limit` selection: walk newest-first,
 * take whole items while they fit, middle-truncate the one that straddles the
 * boundary, then stop. Returns chronological order.
 */
function selectWithinBudget(items, maxTokens, getText) {
  if (!Array.isArray(items) || items.length === 0 || maxTokens <= 0) {
    return { selected: [], droppedCount: Array.isArray(items) ? items.length : 0, tokensUsed: 0 };
  }

  const selected = [];
  let remaining = maxTokens;
  let consumed = 0;

  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (remaining <= 0) break;
    const item = items[i];
    const text = getText(item) || '';
    const tokens = approxTokenCount(text);

    if (tokens <= remaining) {
      selected.push({ item, text, truncated: false });
      remaining -= tokens;
      consumed += tokens;
    } else {
      const { text: truncated } = truncateMiddleWithTokenBudget(text, remaining);
      selected.push({ item, text: truncated, truncated: true });
      consumed += remaining;
      remaining = 0;
      break;
    }
  }

  selected.reverse();
  return { selected, droppedCount: items.length - selected.length, tokensUsed: consumed };
}

function renderPromptBlock(prompts, maxTokens) {
  const { selected, droppedCount, tokensUsed } = selectWithinBudget(prompts, maxTokens, (p) => p.text);
  if (!selected.length) return { text: '', kept: 0, dropped: droppedCount, tokens: 0 };

  const lines = [];
  const total = prompts.length;
  const firstShown = total - selected.length + 1;

  for (let i = 0; i < selected.length; i += 1) {
    const { item, text, truncated } = selected[i];
    const number = firstShown + i;
    const when = item.ts ? ` ts="${item.ts}"` : '';
    const flag = truncated ? ' truncated="true"' : '';
    lines.push(`<user-message n="${number}" of="${total}"${when}${flag}>`);
    lines.push(text);
    lines.push('</user-message>');
  }

  return { text: lines.join('\n'), kept: selected.length, dropped: droppedCount, tokens: tokensUsed };
}

function renderDigestBlock(batches, prompts, { digestBudgetTokens, turnDigestMaxTokens }) {
  const turns = groupBatchesByTurn(batches, prompts);
  const rendered = turns.map((turn) => renderTurnDigest(turn, { maxTokens: turnDigestMaxTokens })).filter(Boolean);

  const { selected, droppedCount, tokensUsed } = selectWithinBudget(rendered, digestBudgetTokens, (d) => d.text);
  if (!selected.length) return { text: '', kept: 0, dropped: droppedCount, tokens: 0 };

  return {
    text: selected.map((s) => s.text).join('\n\n'),
    kept: selected.length,
    dropped: droppedCount,
    tokens: tokensUsed,
  };
}

/**
 * Build the full block injected into the model after a compaction.
 * Returns null when there is nothing worth restoring.
 */
function buildRestoreBlock({ prompts, batches, config, goal = null }) {
  const compact = config.compact || {};
  const promptBlock = renderPromptBlock(prompts || [], compact.userMessageMaxTokens ?? 20000);
  const digestBlock = compact.recordTurns === false
    ? { text: '', kept: 0, dropped: 0, tokens: 0 }
    : renderDigestBlock(batches || [], prompts || [], {
        digestBudgetTokens: compact.digestBudgetTokens ?? 20000,
        turnDigestMaxTokens: compact.turnDigestMaxTokens ?? 20000,
      });

  if (!promptBlock.text && !digestBlock.text && !goal) return null;

  const sections = [];
  sections.push(
    '<bandaid-restored-context>',
    RESTORE_FRAMING,
    '',
    'Bandaid is now restoring what a summary cannot carry. Treat the material below as authoritative primary source and the summary as secondary interpretation. Where they disagree, the material below wins.',
  );

  if (promptBlock.text) {
    const droppedNote =
      promptBlock.dropped > 0
        ? ` The ${promptBlock.dropped} oldest message(s) exceeded the ${compact.userMessageMaxTokens ?? 20000}-token verbatim budget and are covered only by the summary.`
        : '';
    sections.push(
      '',
      '<verbatim-user-messages>',
      `Every instruction the user actually typed, word for word, newest-first within budget.${droppedNote} Standing constraints, preferences, and corrections in here remain in force even if they were already satisfied once — re-read them before deciding what to do next.`,
      '',
      promptBlock.text,
      '</verbatim-user-messages>',
    );
  }

  if (digestBlock.text) {
    const droppedNote = digestBlock.dropped > 0 ? ` (${digestBlock.dropped} older turn(s) omitted)` : '';
    sections.push(
      '',
      '<turn-tool-digests>',
      `What was actually run and what came back, per turn${droppedNote}. Use this instead of re-running work that already happened; check current state before trusting any result as still true.`,
      '',
      digestBlock.text,
      '</turn-tool-digests>',
    );
  }

  if (goal && goal.status === 'active') {
    sections.push(
      '',
      '<active-goal>',
      'This objective survived the compaction and is still open:',
      '',
      goal.objective,
      '</active-goal>',
    );
  }

  sections.push('</bandaid-restored-context>');

  const text = sections.join('\n');
  return {
    text,
    stats: {
      promptsKept: promptBlock.kept,
      promptsDropped: promptBlock.dropped,
      promptTokens: promptBlock.tokens,
      turnsKept: digestBlock.kept,
      turnsDropped: digestBlock.dropped,
      digestTokens: digestBlock.tokens,
      totalTokens: approxTokenCount(text),
    },
  };
}

module.exports = { buildRestoreBlock, renderDigestBlock, renderPromptBlock, selectWithinBudget };
