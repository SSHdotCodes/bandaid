'use strict';

/**
 * Is that a question, or a request for a permission slip?
 *
 * The goal system bounds itself six ways, and one of the six was a single line of
 * punctuation-counting: if the last non-blank line ended in `?`, the stop was
 * allowed unconditionally. So a turn ending "Should I proceed?" bypassed the
 * completion audit, the fixed criteria, and every verifier tier.
 *
 * The reason that check exists is a good one, and it is written down in goals.js:
 * blocking a genuine question traps the user in a loop where the question is never
 * actually asked. That failure is worse than the one this module fixes.
 *
 * So the asymmetry sets the threshold, not accuracy:
 *
 *   blocking a genuine question   the user is locked out of a conversation they
 *                                 are needed in, until the budget runs out
 *   allowing a permission-ask     today's behaviour; one turn ends early and the
 *                                 user types "continue"
 *
 * The second is a mild annoyance and the status quo. The first is a trap. So the
 * gate is **precision on the allow class** — of the questions let through, how many
 * were genuine — and anything this cannot confidently call a permission-ask is
 * allowed. Uncertainty resolves to the old behaviour, the same fail-open posture
 * verify.js takes when a judge verdict cannot be parsed.
 *
 * This mirrors eval/run.js choosing `complete` as its positive class "because
 * calling unfinished work done is the expensive error": pick the class whose false
 * positives hurt, and optimise that one.
 */

/**
 * Asking to do work that is already in scope. These block.
 *
 * Each one is anchored to the end of the line, because the shape being matched is
 * a closing request for approval — not a mention of one earlier in a paragraph.
 */
const PERMISSION_PATTERNS = [
  // Offers to carry on with work already assigned.
  /\b(shall|should|shall)\s+i\s+(proceed|continue|carry\s+on|go\s+ahead|start|begin|keep\s+going)\b/i,
  /\b(want|would\s+you\s+like|do\s+you\s+want|would\s+you\s+prefer)\s+me\s+to\s+(proceed|continue|carry\s+on|go\s+ahead|keep\s+going|start|begin)\b/i,
  /\b(ready|ok|okay|fine|happy)\s+for\s+me\s+to\s+(proceed|continue|go\s+ahead|start|begin)\b/i,
  /\b(ok|okay)\s+to\s+(proceed|continue|go\s+ahead|carry\s+on)\b/i,
  /\b(can|may)\s+i\s+(proceed|continue|go\s+ahead|carry\s+on|start)\b/i,
  /\bshould\s+i\s+keep\s+(going|working)\b/i,
  /\blet\s+me\s+know\s+(if|when)\s+you\s+want\s+me\s+to\s+(proceed|continue)\b/i,

  // Progress checkpoints with no question content — nothing is actually being asked.
  /^(does\s+that\s+|is\s+that\s+)?(sound|look)s?\s+(good|right|ok|okay)\s*\??$/i,
  /^(does\s+that\s+)?makes?\s+sense\s*\??$/i,
  /^any\s+(objections|concerns|thoughts)\s*\??$/i,
  /^(anything|is\s+there\s+anything)\s+(else\s+)?(you'?d\s+like|you\s+want)\s+(me\s+to\s+)?(change|adjust|add)\s*\??$/i,
  /^(all\s+)?good\s*\??$/i,
  /^shall\s+i\s+carry\s+on\s*\??$/i,
];

/**
 * Signals that the environment genuinely cannot supply the answer. Any of these
 * wins over every pattern above, because the cost of getting this wrong is the
 * trap the old one-liner existed to prevent.
 */
const GENUINE_PATTERNS = [
  // A value only the user has.
  /\b(credential|password|api\s*key|token|secret|account|licence|license|invite|url|endpoint|hostname|deadline)\b/i,
  // A decision the model has said it cannot make.
  /\b(which|what)\s+(one|of\s+(these|the|them)|should)\b/i,
  /\bwhich\s+\w+\s+(do|should|would)\s+you\b/i,
  /\bdid\s+you\s+mean\b/i,
  /\bis\s+\S+\s+in\s+scope\b/i,
  /\bwhat\s+(should|would)\s+(the|it|this|that|they)\b/i,
  /\bhow\s+(should|would)\s+(i|we|it|this)\s+\w+/i,
  /\b(prefer|preference)\b/i,
  // An explicit either/or the model is not in a position to rank.
  /\bor\s+(do|would|should)\s+you\b/i,
];

/** The last non-blank line, which is where a closing question lives. */
function trailingLine(message) {
  const text = String(message || '').trim();
  if (!text) return '';
  const lines = text.slice(-800).split('\n').filter((line) => line.trim());
  return (lines[lines.length - 1] || '').trim();
}

/**
 * Does this question overlap something already recorded as blocked?
 *
 * The strongest available signal and it is free. If the model has already told us
 * the environment cannot supply something, a question about that thing is genuine
 * by construction — and the blocker mechanism already exists and is already
 * re-injected every turn.
 */
function matchesBlocker(line, blockers) {
  if (!Array.isArray(blockers) || !blockers.length) return false;
  const words = new Set(
    line
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 4),
  );
  if (!words.size) return false;

  for (const blocker of blockers) {
    const theirs = String(blocker || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 4);
    let shared = 0;
    for (const word of theirs) if (words.has(word)) shared += 1;
    // Two substantial words in common is a deliberate, low bar: erring toward
    // "genuine" is erring toward the old behaviour.
    if (shared >= 2) return true;
  }
  return false;
}

/**
 * `{ kind, matched }` where kind is 'permission' | 'genuine' | 'unknown'.
 *
 * Only 'permission' blocks. 'unknown' is the common case and allows the stop.
 */
function classifyTrailingQuestion(message, { blockers = [] } = {}) {
  const line = trailingLine(message);
  if (!line) return { kind: 'unknown', matched: null };
  if (!line.endsWith('?')) return { kind: 'unknown', matched: null };

  if (matchesBlocker(line, blockers)) return { kind: 'genuine', matched: 'blocker' };

  for (const pattern of GENUINE_PATTERNS) {
    if (pattern.test(line)) return { kind: 'genuine', matched: String(pattern) };
  }
  for (const pattern of PERMISSION_PATTERNS) {
    if (pattern.test(line)) return { kind: 'permission', matched: String(pattern) };
  }

  return { kind: 'unknown', matched: null };
}

module.exports = { GENUINE_PATTERNS, PERMISSION_PATTERNS, classifyTrailingQuestion, matchesBlocker, trailingLine };
