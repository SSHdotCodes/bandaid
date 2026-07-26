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
 * Text that reads as the user correcting or constraining the work, rather than
 * adding to it. These are the messages whose eviction is most expensive: a
 * constraint dropped for being old is a constraint the model is about to break,
 * and this block's own header promises they stay in force.
 *
 * ponytail: a regex, and it will both over- and under-match. The upgrade path is
 * relevance ranking against the active goal, worth doing only if a real ledger
 * shows this misfiring — the cost of a false positive is one pinned message.
 */
const CORRECTION_RE =
  /(?:^|\W)(?:don't|do not|doesn't|never|instead|actually|revert|undo|rather than|not that|wrong|incorrect|stop doing|avoid|no,|nope|make sure|always use|only use|must not)(?:\W|$)/i;

/** Half, so relevance can never starve recency. */
const PINNED_BUDGET_SHARE = 0.5;

function looksLikeCorrection(text) {
  return CORRECTION_RE.test(String(text || ''));
}

/**
 * Codex's `build_compacted_history_with_limit` selection: walk newest-first,
 * take whole items while they fit, middle-truncate the one that straddles the
 * boundary, then stop.
 *
 * `isPinned` is Bandaid's addition. Codex selects purely by recency, which is
 * "the most recent information" where the job is "the right information for the
 * next step" — so items that answer the next step get first claim on a slice of
 * the budget, and the recency walk then spends whatever is left. Returns
 * chronological order either way.
 */
function selectWithinBudget(items, maxTokens, getText, { isPinned = null } = {}) {
  if (!Array.isArray(items) || items.length === 0 || maxTokens <= 0) {
    return { selected: [], droppedCount: Array.isArray(items) ? items.length : 0, tokensUsed: 0 };
  }

  const picked = new Map();
  let consumed = 0;

  const walk = (indices, budget, { truncate }) => {
    let remaining = budget;
    for (let i = indices.length - 1; i >= 0; i -= 1) {
      if (remaining <= 0) break;
      const index = indices[i];
      const text = getText(items[index]) || '';
      const tokens = approxTokenCount(text);

      if (tokens <= remaining) {
        picked.set(index, { index, item: items[index], text, truncated: false });
        remaining -= tokens;
        consumed += tokens;
      } else if (truncate) {
        const { text: truncated } = truncateMiddleWithTokenBudget(text, remaining);
        picked.set(index, { index, item: items[index], text: truncated, truncated: true });
        consumed += remaining;
        remaining = 0;
        break;
      }
      // Not truncating: skip this one and keep packing smaller pinned items.
    }
  };

  const all = items.map((_, i) => i);
  const pinned = isPinned ? all.filter((i) => isPinned(items[i], i)) : [];

  // The pinned pass takes whole items only. Truncation stays where Codex put
  // it — exactly once, on the item that straddles the end of the recency walk —
  // so pinning never turns one usable message into two unreadable stubs.
  if (pinned.length) walk(pinned, Math.floor(maxTokens * PINNED_BUDGET_SHARE), { truncate: false });
  walk(
    all.filter((i) => !picked.has(i)),
    maxTokens - consumed,
    { truncate: true },
  );

  const selected = [...picked.values()].sort((a, b) => a.index - b.index);
  return { selected, droppedCount: items.length - selected.length, tokensUsed: consumed };
}

function renderPromptBlock(prompts, maxTokens, goal = null) {
  const objective = goal && goal.status === 'active' ? String(goal.objective || '').trim() : '';
  const isPinned = (prompt) => {
    const text = String(prompt.text || '');
    // The prompt the goal was made from. In auto mode the objective is that
    // prompt verbatim, so this is an equality check, not a guess.
    if (objective && text.trim() === objective) return true;
    return looksLikeCorrection(text);
  };

  const { selected, droppedCount, tokensUsed } = selectWithinBudget(prompts, maxTokens, (p) => p.text, { isPinned });
  if (!selected.length) return { text: '', kept: 0, dropped: droppedCount, tokens: 0 };

  const lines = [];
  const total = prompts.length;

  // Numbered by real position: pinning makes the kept set non-contiguous, and a
  // gap between n="2" and n="9" is information — it says older messages were
  // dropped, right where they were dropped.
  for (const { index, item, text, truncated } of selected) {
    const when = item.ts ? ` ts="${item.ts}"` : '';
    const flag = truncated ? ' truncated="true"' : '';
    lines.push(`<user-message n="${index + 1}" of="${total}"${when}${flag}>`);
    lines.push(text);
    lines.push('</user-message>');
  }

  return { text: lines.join('\n'), kept: selected.length, dropped: droppedCount, tokens: tokensUsed };
}

function renderDigestBlock(batches, prompts, { digestBudgetTokens, turnDigestMaxTokens }) {
  const turns = groupBatchesByTurn(batches, prompts);
  const rendered = turns.map((turn) => renderTurnDigest(turn, { maxTokens: turnDigestMaxTokens })).filter(Boolean);

  const { selected, droppedCount, tokensUsed } = selectWithinBudget(rendered, digestBudgetTokens, (d) => d.text, {
    // What was tried and failed is the record that stops the next model
    // re-running a dead end or inventing a result for it. Dropping it by age
    // throws away the most expensive thing in the digest.
    isPinned: (digest) => String(digest.text || '').includes('[FAILED]'),
  });
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
  const promptBlock = renderPromptBlock(prompts || [], compact.userMessageMaxTokens ?? 20000, goal);
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
      `Every instruction the user actually typed, word for word. Corrections and constraints are kept ahead of recent messages, so gaps in the numbering are older messages that were dropped, not reordering.${droppedNote} Standing constraints, preferences, and corrections in here remain in force even if they were already satisfied once — re-read them before deciding what to do next.`,
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
    );
    // The criteria have to survive with it. An objective whose bar was summarized
    // away is exactly the objective that gets quietly reinterpreted downward.
    if ((goal.criteria || []).length) {
      sections.push(
        '',
        'It is done when all of these are true, and not before:',
        ...goal.criteria.map((text, i) => `${i + 1}. ${text}`),
      );
    }
    sections.push('</active-goal>');
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

module.exports = {
  buildRestoreBlock,
  looksLikeCorrection,
  renderDigestBlock,
  renderPromptBlock,
  selectWithinBudget,
};
