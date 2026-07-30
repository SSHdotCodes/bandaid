#!/usr/bin/env node
'use strict';

/**
 * Does the estimator beat the dumbest thing that could work?
 *
 * eval/run.js measures the judge. This measures the ETA, and it exists because a
 * projected finish time is acted on: a bare number that nobody scored is worse
 * than no number, since the failure mode is a model deciding it has time it does
 * not have.
 *
 * The baseline it has to beat is one line — median task duration x tasks
 * remaining. No trimming, no spread, no basis selection. If the real estimator
 * does not beat that, **the baseline is the deliverable** and this harness is what
 * says so.
 *
 * Replay, not simulation. For each recorded session it walks the task events
 * forward and, at every point where an estimate would have been rendered,
 * computes it from *only the events up to that point* and compares against the
 * wall-clock that actually elapsed from there to the end of the work. An estimator
 * that can see the future scores perfectly and means nothing, so the prefix
 * discipline is the whole correctness argument.
 *
 *   node eval/eta-backtest.js
 *   node eval/eta-backtest.js --transcript <path>
 *   node eval/eta-backtest.js --json
 *   node eval/eta-backtest.js --ablate fuzzy    # drop guessed-match durations
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-eta-backtest-'));
process.env.BANDAID_HOME = HOME;

const eta = require('../src/lib/eta');
const tasks = require('../src/lib/tasks');

const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite']);

function parseArgs(argv) {
  const flags = { transcript: null, json: false, ablate: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') flags.json = true;
    else if (argv[i] === '--transcript') flags.transcript = argv[i + 1];
    else if (argv[i] === '--ablate') flags.ablate = argv[i + 1];
  }
  return flags;
}

/** Every transcript Claude Code has written for this user. */
function discoverTranscripts() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const out = [];
  let dirs;
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    try {
      for (const file of fs.readdirSync(path.join(root, dir))) {
        if (file.endsWith('.jsonl')) out.push(path.join(root, dir, file));
      }
    } catch {
      // A project directory we cannot read is not a failure of the harness.
    }
  }
  return out;
}

/**
 * The task-tool calls in one transcript, paired with their results and stamped
 * with when they returned.
 */
function taskCalls(transcriptPath) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return [];
  }

  const pending = new Map();
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === 'tool_use' && TASK_TOOLS.has(block.name)) {
        pending.set(block.id, { toolName: block.name, input: block.input });
      }
      if (block.type === 'tool_result' && pending.has(block.tool_use_id)) {
        const call = pending.get(block.tool_use_id);
        pending.delete(block.tool_use_id);
        const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        out.push({ ...call, result: text, at: Date.parse(entry.timestamp) });
      }
    }
  }
  return out.filter((c) => Number.isFinite(c.at)).sort((a, b) => a.at - b.at);
}

/**
 * The shortest actual-remaining worth scoring, in ms.
 *
 * A percentage error against a three-second actual is not a measurement. The first
 * version of this harness had no floor and reported a MAPE of 837,734% — the
 * arithmetic was correct and the number was meaningless, which is precisely the
 * "confident wrong numbers" failure a harness is supposed to prevent rather than
 * produce.
 */
const MIN_ACTUAL_MS = 60_000;

/**
 * MAPE points within which two estimators are called indistinguishable at equal
 * reach.
 *
 * Set from the observed cause rather than picked: with both estimators reduced to
 * a median times units-remaining, the entire measured gap came from how each
 * breaks an even-count tie — average-of-the-two-middles against
 * upper-middle — which moved MAPE by 2 points. A threshold below that would report
 * a naming convention as an accuracy difference.
 */
const INDISTINGUISHABLE_MAPE = 3;

/**
 * Score one session, or decline to.
 *
 * Ground truth for "how much longer" needs a horizon, and a session whose task
 * list is still open does not have one — its last recorded event is where the work
 * had got to, not where it ended. Scoring against that makes every estimate near
 * the end look catastrophically wrong for a reason that has nothing to do with the
 * estimator. So an unfinished session is **unscoreable and is skipped**, which is
 * the honest reading and not a gap to paper over.
 */
function backtestSession(transcriptPath, { ablateFuzzy = false } = {}) {
  const calls = taskCalls(transcriptPath);
  if (calls.length < 4) return null;

  const base = `bt-${path.basename(transcriptPath, '.jsonl')}`;
  const replay = (id) => {
    calls.forEach((call, index) => {
      tasks.observe(id, {
        toolName: call.toolName,
        input: call.input,
        result: call.result,
        turnIndex: index + 1,
        now: call.at,
      });
    });
    return tasks.state(id);
  };

  // A separate ledger for the finish check, so the scoring pass starts empty.
  const final = replay(`${base}-probe`);
  if (!final || final.total === 0) return null;
  if (final.completed < final.total) {
    return { transcript: transcriptPath, unfinished: true, open: final.total - final.completed };
  }

  const horizon = calls[calls.length - 1].at;
  const sessionId = `${base}-score`;
  const points = [];

  calls.forEach((call, index) => {
    tasks.observe(sessionId, {
      toolName: call.toolName,
      input: call.input,
      result: call.result,
      turnIndex: index + 1,
      now: call.at,
    });

    // Only the events up to and including this one exist in the ledger, so the
    // estimator physically cannot see ahead.
    const stateNow = tasks.state(sessionId);
    if (!stateNow) return;

    const usable = ablateFuzzy
      ? { ...stateNow, durations: stateNow.fuzzyDurations ? [] : stateNow.durations }
      : stateNow;

    const actual = horizon - call.at;
    if (actual < MIN_ACTUAL_MS) return;

    const est = eta.estimate({ continuations: index + 1, continuationAt: [] }, { taskState: usable });
    const base = eta.baseline({}, { taskState: usable });
    if (!est && !base) return;

    points.push({
      at: call.at,
      actual,
      estimate: est ? est.remainingMs : null,
      baseline: base ? base.remainingMs : null,
      basis: est ? est.basis : null,
      n: est ? est.n : 0,
    });
  });

  if (!points.length) return null;
  return { transcript: transcriptPath, tasks: calls.length, points };
}

function score(points, key) {
  const usable = points.filter((p) => p[key] != null);
  if (!usable.length) return null;

  const errors = usable.map((p) => Math.abs(p[key] - p.actual) / p.actual);
  const signed = usable.map((p) => (p[key] - p.actual) / p.actual);
  const within2x = usable.filter((p) => p[key] <= p.actual * 2 && p[key] >= p.actual / 2);

  const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;
  return {
    n: usable.length,
    mape: Math.round(mean(errors) * 100),
    within2x: Math.round((within2x.length / usable.length) * 100),
    bias: Math.round(mean(signed) * 100),
  };
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const transcripts = flags.transcript ? [flags.transcript] : discoverTranscripts();

  const scored = [];
  let unfinished = 0;
  for (const transcript of transcripts) {
    const result = backtestSession(transcript, { ablateFuzzy: flags.ablate === 'fuzzy' });
    if (!result) continue;
    if (result.unfinished) unfinished += 1;
    else scored.push(result);
  }
  const results = scored;

  // Skip cleanly rather than failing when the inputs do not exist. The same
  // posture eval/run.js takes when `claude` is not on PATH: a harness with nothing
  // to measure has not found a problem.
  if (!results.length) {
    const lines = [
      '',
      '  eta-backtest: nothing scoreable.',
      `  examined ${transcripts.length} transcript(s)`,
      '  a session needs 4+ task-tool calls and a task list that actually finished',
      `  ${unfinished} session(s) had a task list still open, so they have no horizon to score against`,
      '',
      '  This is the expected result until sessions accumulate. Across 15 local',
      '  sessions measured while brief 3 was built, 1 used a task tool at all — so',
      '  the estimator ships labelled unmeasured rather than calibrated.',
      '',
    ];
    if (flags.json) {
      console.log(JSON.stringify({ skipped: true, examined: transcripts.length, unfinished }, null, 2));
    }
    else console.log(lines.join('\n'));
    return;
  }

  const allPoints = results.flatMap((r) => r.points);

  // Score both on the *same* points, or the comparison is not one. The estimator
  // deliberately refuses below its observation floor while the baseline will answer
  // from a single sample, so scoring each on whatever it happened to answer would
  // credit the estimator for declining the hardest early points.
  const paired = allPoints.filter((p) => p.estimate != null && p.baseline != null);
  const estScore = score(paired, 'estimate');
  const baseScore = score(paired, 'baseline');
  const declined = allPoints.length - paired.length;

  if (flags.json) {
    console.log(JSON.stringify({ sessions: results.length, points: allPoints.length, estScore, baseScore }, null, 2));
    return;
  }

  const cell = (s, k) => (s ? String(s[k]) : '—');
  console.log('');
  console.log(`  sessions   ${results.length} (${allPoints.length} points, ${paired.length} scored on both)`);
  console.log(`  declined   ${declined} point(s) where the estimator refused and the baseline answered`);
  console.log(`  MAPE       est ${cell(estScore, 'mape')}%   baseline ${cell(baseScore, 'mape')}%`);
  console.log(`  within 2x  est ${cell(estScore, 'within2x')}%   baseline ${cell(baseScore, 'within2x')}%`);
  console.log(`  bias       est ${cell(estScore, 'bias')}%   baseline ${cell(baseScore, 'bias')}%     (positive = overestimates)`);

  if (!estScore || !baseScore) {
    console.log('  verdict    not comparable — one side produced no estimates');
    console.log('');
    return;
  }

  // within-2x decides, not MAPE. Nobody acts on the difference between 30 and 35
  // minutes; everybody acts on the difference between 30 minutes and four hours.
  //
  // The third verdict matters as much as the other two. When the estimator has
  // converged on the baseline — which is what happened here, after the backtest
  // removed the one thing that made it different — the remaining MAPE gap is
  // arithmetic convention, not accuracy, and reporting that as a loss would be as
  // misleading as reporting it as a win.
  const sameReach = estScore.within2x === baseScore.within2x;
  const gap = Math.abs(estScore.mape - baseScore.mape);
  const verdict = !sameReach
    ? estScore.within2x > baseScore.within2x
      ? 'beats baseline'
      : 'does NOT beat baseline — the baseline is the deliverable'
    : gap <= INDISTINGUISHABLE_MAPE
      ? 'indistinguishable — no measured reason to prefer either'
      : estScore.mape < baseScore.mape
        ? 'beats baseline on MAPE at equal reach'
        : 'does NOT beat baseline — the baseline is the deliverable';

  console.log(`  verdict    ${verdict}`);
  if (verdict.startsWith('indistinguishable')) {
    console.log('             what is left unmeasured: the observation floor, the');
    console.log('             interquartile range, and the continuation basis');
  }
  console.log('');
  if (verdict.startsWith('does NOT')) process.exitCode = 1;
}

try {
  main();
} finally {
  fs.rmSync(HOME, { recursive: true, force: true });
}
