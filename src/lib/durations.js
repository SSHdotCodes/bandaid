'use strict';

const fs = require('node:fs');
const path = require('node:path');

const project = require('./project');
const store = require('./store');
const { readToolTimings } = require('./transcript');

/**
 * How long this project's tools actually take.
 *
 * Nothing here is shown to the model. It is the data layer an estimate is built
 * from, and it earns its place by being read rather than by being printed — a
 * "slowest tools this goal" block would be easy to write, would read as
 * insightful, and would be the third block added to the continuation prompt
 * before anything had measured whether the first two helped.
 *
 * Keyed by project rather than session, following handoff.json and
 * evidence.jsonl: a repository's Bash calls are slow because its test suite is
 * slow, which is a property of the project and the whole reason this is worth
 * keeping across sessions.
 *
 * Percentiles, never means. One 4-minute test run ruins a mean and barely moves a
 * p50, and tool durations are exactly the long-tailed shape where that matters.
 */

/**
 * Samples kept per tool. A rolling window, so a project whose test suite got ten
 * times faster today stops reporting yesterday's p95 within a few hundred calls.
 */
const MAX_SAMPLES = 500;

const SCHEMA = 'bandaid.durations/1';

function durationsFile(projectRoot) {
  if (!projectRoot) return null;
  return path.join(project.projectDir(projectRoot), 'durations.json');
}

function read(projectRoot) {
  const file = durationsFile(projectRoot);
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return { schema: SCHEMA, tools: {}, syncedThrough: null, ...parsed };
  } catch {
    return null;
  }
}

function empty() {
  return { schema: SCHEMA, tools: {}, syncedThrough: null, updatedAt: null };
}

function write(projectRoot, record) {
  const file = durationsFile(projectRoot);
  if (!file) return null;
  const next = { ...record, updatedAt: new Date().toISOString() };
  store.writeJson(file, next);
  return next;
}

/**
 * Nearest-rank percentile over a sorted copy. Deliberately not interpolated:
 * an interpolated p95 over 11 samples invents a number that was never measured.
 */
function percentile(samples, q) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

/**
 * Fold new samples in, keeping the trailing window per tool.
 *
 * `timing` is carried per tool rather than per sample so a consumer can tell what
 * it is looking at without storing a derivation tag on every number. A tool whose
 * samples came from two derivations reports both counts.
 */
function fold(record, samples) {
  const tools = { ...record.tools };

  for (const sample of samples) {
    if (!sample || !sample.name || !Number.isFinite(sample.durationMs)) continue;
    const existing = tools[sample.name] || { samples: [], timing: {} };
    const timing = sample.timing || 'transcript';
    tools[sample.name] = {
      samples: [...existing.samples, sample.durationMs].slice(-MAX_SAMPLES),
      timing: { ...existing.timing, [timing]: (existing.timing[timing] || 0) + 1 },
    };
  }

  return { ...record, tools };
}

/**
 * Fold the transcript's real per-call durations into this project's profile.
 *
 * Runs at Stop rather than at PostToolBatch: the transcript entry for a call does
 * not exist until after the call resolves, so there is nothing to read at hook
 * time. The transcript is append-only, so a high-water mark is enough to make
 * repeated syncs idempotent — no set of seen ids to grow without bound.
 *
 * Never throws. A profile is a nicety and a broken one must not cost a stop.
 */
function sync(projectRoot, transcriptPath) {
  if (!projectRoot || !transcriptPath) return null;
  try {
    const current = read(projectRoot) || empty();
    const fresh = readToolTimings(transcriptPath, { since: current.syncedThrough });
    if (!fresh.length) return current;

    const latest = fresh.reduce((max, s) => (s.endedAt > max ? s.endedAt : max), current.syncedThrough || '');
    const folded = fold(current, fresh.map((s) => ({ ...s, timing: 'transcript' })));
    return write(projectRoot, { ...folded, syncedThrough: latest || current.syncedThrough });
  } catch {
    return null;
  }
}

/** Record samples that did not come from the transcript — a hook or a gap. */
function record(projectRoot, samples) {
  if (!projectRoot || !samples || !samples.length) return null;
  try {
    return write(projectRoot, fold(read(projectRoot) || empty(), samples));
  } catch {
    return null;
  }
}

/**
 * The profile, as percentiles. `null` when this project has nothing recorded, so
 * a caller can tell "no data" from "fast".
 */
function profile(projectRoot) {
  const current = read(projectRoot);
  if (!current) return null;

  const tools = {};
  for (const [name, entry] of Object.entries(current.tools || {})) {
    const samples = Array.isArray(entry.samples) ? entry.samples.filter((n) => Number.isFinite(n)) : [];
    if (!samples.length) continue;
    tools[name] = {
      n: samples.length,
      p50: percentile(samples, 0.5),
      // A tool seen once has no meaningful tail; reporting its single sample as a
      // p95 would read as a measured ceiling.
      p95: samples.length >= 5 ? percentile(samples, 0.95) : null,
      max: Math.max(...samples),
      timing: entry.timing || {},
    };
  }

  if (!Object.keys(tools).length) return null;
  return { tools, syncedThrough: current.syncedThrough || null, updatedAt: current.updatedAt || null };
}

// No gc, deliberately. The file is bounded by construction — MAX_SAMPLES per tool
// and a handful of tools — so it cannot grow the way an append-only ledger can.
// What is unbounded is the number of *project* directories, which is equally true
// of handoff.json and evidence.jsonl and is not solved for either; inventing a
// sweep here that nothing else has would be a mechanism with no measurement
// behind it.

module.exports = { MAX_SAMPLES, empty, fold, percentile, profile, read, record, sync };
