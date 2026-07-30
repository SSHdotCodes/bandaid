'use strict';

/**
 * The tool duration profile.
 *
 * The failure this exists to catch is a profile that looks right and is wrong:
 * a zero folded in where a duration was unknown, a mean where a percentile was
 * meant, a single sample reported as a measured tail, or a repeated sync counting
 * the same call twice. Every one of those produces confident numbers, and the
 * estimator built on top would inherit them silently.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-durations-'));
process.env.BANDAID_HOME = HOME;

const durations = require('../src/lib/durations');
const { readToolTimings } = require('../src/lib/transcript');

const scratch = [];
after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-dur-root-'));
  scratch.push(dir);
  return dir;
}

/** A transcript with one assistant tool_use per call and its matching result. */
function transcript(calls) {
  const lines = [];
  calls.forEach((call, i) => {
    const uuid = `a${i}`;
    const useId = `tu${i}`;
    lines.push(
      JSON.stringify({
        type: 'assistant',
        uuid,
        timestamp: call.startedAt,
        message: { content: [{ type: 'tool_use', id: useId, name: call.name }] },
      }),
    );
    lines.push(
      JSON.stringify({
        type: 'user',
        uuid: `u${i}`,
        sourceToolAssistantUUID: uuid,
        timestamp: call.endedAt,
        message: { content: [{ type: 'tool_result', tool_use_id: useId }] },
      }),
    );
  });
  const file = path.join(tmpdir(), 'transcript.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

describe('percentile', () => {
  it('is nearest-rank, so every number it reports was actually measured', () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    assert.equal(durations.percentile(samples, 0.5), 50);
    assert.equal(durations.percentile(samples, 0.95), 100);
    assert.equal(durations.percentile(samples, 0), 10);
    assert.equal(durations.percentile(samples, 1), 100);
  });

  it('does not care what order the samples arrived in', () => {
    assert.equal(durations.percentile([90, 10, 50, 30, 70], 0.5), 50);
  });

  it('handles an odd count and a single sample', () => {
    assert.equal(durations.percentile([1, 2, 3], 0.5), 2);
    assert.equal(durations.percentile([42], 0.5), 42);
    assert.equal(durations.percentile([], 0.5), null);
  });

  it('is a percentile and not a mean, which one outlier would wreck', () => {
    const withOutlier = [100, 100, 100, 100, 3_600_000];
    assert.equal(durations.percentile(withOutlier, 0.5), 100);
    const mean = withOutlier.reduce((a, b) => a + b, 0) / withOutlier.length;
    assert.ok(mean > 700_000, 'the mean really is that bad — that is the point');
  });
});

describe('fold', () => {
  it('keeps only the trailing window, so a long-lived project cannot grow forever', () => {
    const samples = Array.from({ length: durations.MAX_SAMPLES + 200 }, (_, i) => ({ name: 'Bash', durationMs: i }));
    const folded = durations.fold(durations.empty(), samples);
    assert.equal(folded.tools.Bash.samples.length, durations.MAX_SAMPLES);
    // The window is the *newest* samples: the oldest 200 are gone.
    assert.equal(folded.tools.Bash.samples[0], 200);
  });

  it('counts each derivation separately rather than blending them', () => {
    const folded = durations.fold(durations.empty(), [
      { name: 'Bash', durationMs: 10, timing: 'transcript' },
      { name: 'Bash', durationMs: 20, timing: 'gap' },
      { name: 'Bash', durationMs: 30, timing: 'transcript' },
    ]);
    assert.deepEqual(folded.tools.Bash.timing, { transcript: 2, gap: 1 });
  });

  it('drops a sample with no duration instead of folding in a zero', () => {
    const folded = durations.fold(durations.empty(), [
      { name: 'Bash', durationMs: null },
      { name: 'Bash', durationMs: undefined },
      { name: 'Bash', durationMs: 'slow' },
      { name: null, durationMs: 10 },
      { name: 'Bash', durationMs: 500 },
    ]);
    assert.deepEqual(folded.tools.Bash.samples, [500], 'a zero here would drag every estimate down');
  });
});

describe('profile', () => {
  it('reports null for a project with nothing recorded, so "no data" is not "fast"', () => {
    assert.equal(durations.profile(tmpdir()), null);
  });

  it('withholds a p95 until there are enough samples to have a tail', () => {
    const root = tmpdir();
    durations.record(root, [
      { name: 'Read', durationMs: 40 },
      { name: 'Read', durationMs: 50 },
      { name: 'Read', durationMs: 60 },
    ]);
    const few = durations.profile(root);
    assert.equal(few.tools.Read.n, 3);
    assert.equal(few.tools.Read.p50, 50);
    assert.equal(few.tools.Read.p95, null, 'one sample reported as a p95 reads as a measured ceiling');

    durations.record(root, [
      { name: 'Read', durationMs: 70 },
      { name: 'Read', durationMs: 900 },
    ]);
    assert.equal(durations.profile(root).tools.Read.p95, 900);
  });

  it('survives a corrupt profile file rather than taking a stop down with it', () => {
    const root = tmpdir();
    durations.record(root, [{ name: 'Bash', durationMs: 10 }]);
    const file = path.join(require('../src/lib/project').projectDir(root), 'durations.json');
    fs.writeFileSync(file, '{ not json');
    assert.equal(durations.profile(root), null);
    // And it recovers: the next write starts from empty rather than throwing.
    assert.ok(durations.record(root, [{ name: 'Bash', durationMs: 20 }]));
    assert.equal(durations.profile(root).tools.Bash.n, 1);
  });
});

describe('sync', () => {
  const CALLS = [
    { name: 'Read', startedAt: '2026-07-30T10:00:00.000Z', endedAt: '2026-07-30T10:00:00.050Z' },
    { name: 'Bash', startedAt: '2026-07-30T10:00:01.000Z', endedAt: '2026-07-30T10:00:03.000Z' },
    { name: 'Bash', startedAt: '2026-07-30T10:00:04.000Z', endedAt: '2026-07-30T10:00:04.100Z' },
  ];

  it('reads real per-call durations out of the transcript', () => {
    const root = tmpdir();
    durations.sync(root, transcript(CALLS));
    const result = durations.profile(root);
    assert.equal(result.tools.Read.n, 1);
    assert.equal(result.tools.Read.p50, 50);
    assert.equal(result.tools.Bash.n, 2);
    assert.equal(result.tools.Bash.max, 2000);
    assert.deepEqual(result.tools.Bash.timing, { transcript: 2 });
  });

  it('is idempotent, so a stop that syncs a growing transcript counts nothing twice', () => {
    const root = tmpdir();
    const file = transcript(CALLS);
    durations.sync(root, file);
    durations.sync(root, file);
    durations.sync(root, file);
    const result = durations.profile(root);
    assert.equal(result.tools.Read.n, 1);
    assert.equal(result.tools.Bash.n, 2);
  });

  it('picks up only what is new when the transcript grows', () => {
    const root = tmpdir();
    durations.sync(root, transcript(CALLS));
    durations.sync(
      root,
      transcript([
        ...CALLS,
        { name: 'Write', startedAt: '2026-07-30T10:05:00.000Z', endedAt: '2026-07-30T10:05:00.300Z' },
      ]),
    );
    const result = durations.profile(root);
    assert.equal(result.tools.Bash.n, 2, 'the old calls are not re-counted');
    assert.equal(result.tools.Write.n, 1);
  });

  it('says nothing rather than throwing when there is no transcript to read', () => {
    const root = tmpdir();
    assert.equal(durations.sync(root, null), null);
    assert.equal(durations.sync(null, 'whatever'), null);
    assert.doesNotThrow(() => durations.sync(root, '/no/such/transcript.jsonl'));
  });
});

describe('readToolTimings', () => {
  it('joins a result back to its call and subtracts the timestamps', () => {
    const file = transcript([
      { name: 'Bash', startedAt: '2026-07-30T10:00:00.000Z', endedAt: '2026-07-30T10:00:02.500Z' },
    ]);
    const [call] = readToolTimings(file);
    assert.equal(call.name, 'Bash');
    assert.equal(call.durationMs, 2500);
  });

  it('ignores a result whose call it cannot find, rather than guessing a start', () => {
    const file = path.join(tmpdir(), 'orphan.jsonl');
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        type: 'user',
        sourceToolAssistantUUID: 'missing',
        timestamp: '2026-07-30T10:00:00.000Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] },
      })}\n`,
    );
    assert.deepEqual(readToolTimings(file), []);
  });

  it('never reports a negative duration on a clock that moved backwards', () => {
    const file = transcript([
      { name: 'Bash', startedAt: '2026-07-30T10:00:05.000Z', endedAt: '2026-07-30T10:00:00.000Z' },
    ]);
    assert.equal(readToolTimings(file)[0].durationMs, 0);
  });

  it('honours the high-water mark exclusively, so the boundary call is not repeated', () => {
    const file = transcript([
      { name: 'Read', startedAt: '2026-07-30T10:00:00.000Z', endedAt: '2026-07-30T10:00:01.000Z' },
      { name: 'Write', startedAt: '2026-07-30T10:00:02.000Z', endedAt: '2026-07-30T10:00:03.000Z' },
    ]);
    const after1 = readToolTimings(file, { since: '2026-07-30T10:00:01.000Z' });
    assert.deepEqual(after1.map((c) => c.name), ['Write']);
  });

  it('survives a torn line and a transcript that is not there at all', () => {
    const file = path.join(tmpdir(), 'torn.jsonl');
    fs.writeFileSync(file, '{"type":"assistant"\n{"nope"\n');
    assert.deepEqual(readToolTimings(file), []);
    assert.deepEqual(readToolTimings('/no/such/file.jsonl'), []);
    assert.deepEqual(readToolTimings(null), []);
  });
});
