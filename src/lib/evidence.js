'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const project = require('./project');
const store = require('./store');
const { selectWithinBudget } = require('./restore');
const { stampMatches } = require('./stamp');

/**
 * The evidence ledger: claims with pointers, accumulated across sessions.
 *
 * The judge is handed a rendered digest of the current session's tool calls,
 * which is better than a transcript and still dies with the session. On day
 * three of a goal it sees nothing at all from days one and two.
 *
 * The fix is not more storage, it is a different shape. A tool digest says
 * *what happened*; an evidence record says *what is claimed to be true, and
 * where to go and check*. The second is verifiable and the first has to be
 * believed or redone.
 *
 * The asymmetry that makes the file worth reading: the runtime writes what it
 * measured from an exit status, and the model may only ever append an
 * `unverified` claim. A claim is a lead for the judge to follow, never a
 * finding — which is exactly the distinction the whole system exists to keep.
 *
 * ponytail: `npm run eval -- --ablate ledger` scores 10/10, identical to a
 * plain run — on that suite this file earns nothing, and it costs up to 3000
 * tokens per judged stop. It is kept because the suite cannot test what it is
 * for: every fixture is one judgement over a fresh repository that already
 * contains the ground truth, so a judge that reads the files needs no history.
 * The case this exists for is day three, where the dead end was walked on day
 * one. Treat it as unmeasured rather than proven, and delete it if a
 * two-judgement fixture ever shows it still moves nothing. Reviewed 2026-07-28.
 */

const KINDS = new Set(['check', 'probe', 'judge', 'claim', 'blocker', 'violation', 'expect']);
const VERDICTS = new Set(['supported', 'refuted', 'unverified']);

/** Only the runtime may say something was measured. */
const MEASURED_KINDS = new Set(['check', 'probe', 'judge', 'expect']);

const DEFAULT_MAX_TOKENS = 3000;
const DEFAULT_MAX_RECORDS = 2000;

function evidenceFile(cwd) {
  return path.join(project.projectDir(cwd), 'evidence.jsonl');
}

/** Records from a previous objective stay on disk and are never shown. */
function objectiveHash(objective) {
  return crypto
    .createHash('sha1')
    .update(String(objective || '').trim())
    .digest('hex')
    .slice(0, 8);
}

function normalizePointers(pointers) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(pointers) ? pointers : [pointers]) {
    const text = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * Append one record. Returns it, or null when there was nothing to say.
 *
 * `byModel` is the gate: anything the model authored is forced to
 * `kind: 'claim'` and `verdict: 'unverified'` no matter what it asked for.
 */
function append(cwd, entry = {}, { byModel = false } = {}) {
  const claim = String(entry.claim == null ? '' : entry.claim).replace(/\s+/g, ' ').trim();
  if (!claim) return null;

  const kind = byModel ? 'claim' : KINDS.has(entry.kind) ? entry.kind : 'claim';
  const verdict = byModel
    ? 'unverified'
    : VERDICTS.has(entry.verdict)
      ? entry.verdict
      : 'unverified';

  const criterion = Number.isInteger(entry.criterion) && entry.criterion > 0 ? entry.criterion : null;

  const record = {
    ts: new Date().toISOString(),
    sessionId: entry.sessionId || null,
    objectiveHash: entry.objectiveHash || null,
    criterion,
    kind,
    claim,
    pointers: normalizePointers(entry.pointers),
    verdict,
    detail: entry.detail ? String(entry.detail).slice(0, 2000) : null,
    stamp: entry.stamp || null,
  };

  try {
    store.appendJsonl(evidenceFile(cwd), record);
  } catch {
    // The ledger is an accelerant, never a dependency. Losing a write must not
    // cost the goal, which is already safely on disk.
    return null;
  }
  return record;
}

/** Every record for one objective, oldest first. */
function read(cwd, { objectiveHash: hash = null } = {}) {
  const all = store.readJsonl(evidenceFile(cwd));
  return hash ? all.filter((r) => r.objectiveHash === hash) : all;
}

/**
 * Classify each criterion against what has actually been recorded.
 *
 * This is the arithmetic the 277-word completion audit is asking the model to
 * perform on itself. Doing it in the runtime means the answer is not up for
 * negotiation.
 */
function coverage(entries, criteriaCount, currentStamp) {
  const out = [];
  for (let i = 1; i <= criteriaCount; i += 1) {
    const mine = entries.filter((r) => r.criterion === i);
    const fresh = mine.filter((r) => stampMatches(r.stamp, currentStamp));

    const measuredRefuted = fresh.find((r) => MEASURED_KINDS.has(r.kind) && r.verdict === 'refuted');
    const measuredSupported = fresh.find((r) => MEASURED_KINDS.has(r.kind) && r.verdict === 'supported');

    let state = 'uncovered';
    let by = null;
    // Two verifiers looking at the same worktree and disagreeing. Usually a
    // green check beside a failing probe on one criterion, and always the state
    // where another blind attempt is worthless — nothing is unfinished, two
    // measurements cannot both be right, and only finding out which resolves it.
    if (measuredRefuted && measuredSupported) {
      state = 'contradicted';
      by = measuredRefuted;
    } else if (measuredRefuted) {
      state = 'refuted';
      by = measuredRefuted;
    } else if (fresh.some((r) => MEASURED_KINDS.has(r.kind) && r.verdict === 'supported')) {
      state = 'covered';
      by = fresh.find((r) => MEASURED_KINDS.has(r.kind) && r.verdict === 'supported');
    } else if (fresh.length) {
      state = 'claimed-only';
      by = fresh[fresh.length - 1];
    } else if (mine.length) {
      state = 'stale';
      by = mine[mine.length - 1];
    }

    out.push({ criterion: i, state, record: by || null });
  }
  return out;
}

/**
 * One line for the continuation prompt.
 *
 * Where the criteria section states the bar, this reports the score — computed,
 * not asserted, and costing a single line rather than the several paragraphs of
 * "grade each criterion individually" it stands in for.
 */
function summarize(entries, criteriaCount, currentStamp) {
  if (!criteriaCount) return '';
  const rows = coverage(entries, criteriaCount, currentStamp);

  const group = (state) =>
    rows
      .filter((r) => r.state === state)
      .map((r) => r.criterion)
      .join(',');

  const parts = [];
  const covered = group('covered');
  const contradicted = group('contradicted');
  const refuted = group('refuted');
  const claimed = group('claimed-only');
  const stale = group('stale');
  const uncovered = group('uncovered');

  if (covered) parts.push(`${covered} measured`);
  if (contradicted) parts.push(`${contradicted} CONTRADICTED — two verifiers disagree`);
  if (refuted) parts.push(`${refuted} refuted`);
  if (claimed) parts.push(`${claimed} asserted but not measured`);
  if (stale) parts.push(`${stale} measured before the worktree changed`);
  if (uncovered) parts.push(`${uncovered} no evidence`);

  return parts.length ? `Evidence by criterion: ${parts.join(' · ')}.` : '';
}

function renderRecord(record, { stale }) {
  const source = MEASURED_KINDS.has(record.kind) ? 'measured ' : 'engineer ';
  const where = record.criterion ? `criterion ${record.criterion}` : 'objective  ';
  const day = String(record.ts || '').slice(0, 16).replace('T', ' ');
  const head = `${where}  ${source} ${record.verdict.padEnd(10)} ${record.claim}${stale ? '  (stale)' : ''}  [${day}]`;
  const lines = [head];
  for (const pointer of record.pointers || []) lines.push(`${' '.repeat(34)}${pointer}`);
  return lines.join('\n');
}

/**
 * The block the judge is given.
 *
 * Fresh records before stale ones, and within each the ordinary newest-first
 * walk — the same two-pass selection compaction already uses, because it is the
 * same problem: fill a budget with the right information, not the most recent.
 */
function render(entries, { maxTokens = DEFAULT_MAX_TOKENS, currentStamp = null } = {}) {
  if (!entries.length) return '';

  const rendered = entries.map((record) => {
    const stale = !stampMatches(record.stamp, currentStamp);
    return { stale, text: renderRecord(record, { stale }) };
  });

  const { selected, droppedCount } = selectWithinBudget(rendered, maxTokens, (r) => r.text, {
    isPinned: (r) => !r.stale,
  });
  if (!selected.length) return '';

  const fresh = selected.filter((s) => !s.item.stale).map((s) => s.text);
  const stale = selected.filter((s) => s.item.stale).map((s) => s.text);

  const parts = [
    'The evidence ledger for this objective, accumulated across every session that has worked it.',
    '',
    'Entries marked "engineer" were written by the engineer doing the work. They are unverified assertions, each carrying a pointer — go and look at what it points to rather than accepting it. Entries marked "measured" were recorded by the runtime from an exit status the engineer did not control: they are facts about what was run, not about what it means.',
    '',
    '<evidence-ledger>',
  ];

  if (fresh.length) parts.push(...fresh);
  if (stale.length) {
    parts.push('', 'Recorded against an earlier state of the worktree. Treat as history, not as current proof — especially the failures, which are the record of what has already been tried:', ...stale);
  }
  if (droppedCount > 0) parts.push('', `(${droppedCount} older entr(ies) omitted)`);

  parts.push('</evidence-ledger>');
  return parts.join('\n');
}

/** Keep the file bounded. Oldest records go first; the newest are the useful ones. */
function gc(cwd, { maxRecords = DEFAULT_MAX_RECORDS } = {}) {
  const file = evidenceFile(cwd);
  const all = store.readJsonl(file);
  if (all.length <= maxRecords) return 0;

  const keep = all.slice(all.length - maxRecords);
  try {
    fs.writeFileSync(file, `${keep.map((r) => JSON.stringify(r)).join('\n')}\n`);
  } catch {
    return 0;
  }
  return all.length - keep.length;
}

module.exports = {
  DEFAULT_MAX_RECORDS,
  DEFAULT_MAX_TOKENS,
  KINDS,
  MEASURED_KINDS,
  append,
  coverage,
  evidenceFile,
  gc,
  objectiveHash,
  read,
  render,
  summarize,
};
