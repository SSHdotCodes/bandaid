'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-store-'));
process.env.BANDAID_HOME = HOME;

const store = require('../src/lib/store');

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

function seedTurns(sessionId, count, { padBytes = 0 } = {}) {
  store.ensureSessionDir(sessionId);
  const lines = [];
  for (let i = 1; i <= count; i += 1) {
    lines.push(
      JSON.stringify({
        ts: `2026-07-27T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
        turnIndex: i,
        calls: [{ name: 'Bash', input: 'x'.repeat(padBytes), result: `turn ${i}` }],
      }),
    );
  }
  fs.writeFileSync(store.turnsFile(sessionId), `${lines.join('\n')}\n`);
}

describe('readTurnsSince', () => {
  it('returns only the turns a goal is accountable for', () => {
    seedTurns('tail-basic', 10);
    const turns = store.readTurnsSince('tail-basic', 7);
    assert.deepEqual(
      turns.map((t) => t.turnIndex),
      [7, 8, 9, 10],
    );
  });

  it('agrees with a full read filtered the old way, across a chunk boundary', () => {
    // ~1.5 MB, so the backwards walk has to take several 256 KiB chunks and
    // stitch them together. This is the case the whole function exists for.
    seedTurns('tail-large', 400, { padBytes: 4000 });
    const file = store.turnsFile('tail-large');
    assert.ok(fs.statSync(file).size > 1_000_000, 'fixture must exceed one chunk');

    const expected = store.readTurns('tail-large').filter((t) => t.turnIndex >= 120);
    const actual = store.readTurnsSince('tail-large', 120);

    assert.equal(actual.length, expected.length);
    assert.deepEqual(actual, expected, 'the fast path must not differ from the slow one');
  });

  it('reads the whole file when the goal started at the beginning', () => {
    seedTurns('tail-zero', 5);
    assert.equal(store.readTurnsSince('tail-zero', 0).length, 5);
  });

  it('is empty rather than throwing when there is no ledger', () => {
    assert.deepEqual(store.readTurnsSince('tail-missing', 3), []);
  });

  it('survives a torn final line from a killed hook', () => {
    seedTurns('tail-torn', 6);
    fs.appendFileSync(store.turnsFile('tail-torn'), '{"turnIndex":7,"calls":[');
    assert.deepEqual(
      store.readTurnsSince('tail-torn', 5).map((t) => t.turnIndex),
      [5, 6],
    );
  });

  it('does not corrupt multi-byte text split across a chunk boundary', () => {
    store.ensureSessionDir('tail-utf8');
    const lines = [];
    for (let i = 1; i <= 200; i += 1) {
      lines.push(JSON.stringify({ turnIndex: i, calls: [{ name: 'Bash', result: '→…é'.repeat(2000) }] }));
    }
    fs.writeFileSync(store.turnsFile('tail-utf8'), `${lines.join('\n')}\n`);

    const turns = store.readTurnsSince('tail-utf8', 150);
    assert.equal(turns.length, 51);
    for (const turn of turns) {
      assert.ok(turn.calls[0].result.startsWith('→…é'), 'a split code point must not reach the parser');
    }
  });
});

describe('lastTurnTs', () => {
  it('returns the newest record without parsing the whole file', () => {
    seedTurns('last-ts', 40);
    assert.equal(store.lastTurnTs('last-ts'), '2026-07-27T00:00:40.000Z');
  });

  it('reads across a chunk boundary', () => {
    // Same padding trick the readTurnsSince cases use: force the backwards walk to
    // need more than one chunk.
    seedTurns('last-ts-big', 60, { padBytes: 20_000 });
    assert.equal(store.lastTurnTs('last-ts-big'), '2026-07-27T00:00:00.000Z');
  });

  it('ignores a torn final line rather than returning nothing', () => {
    seedTurns('last-ts-torn', 3);
    fs.appendFileSync(store.turnsFile('last-ts-torn'), '{"ts":"2026-07-27T00:00:09.000Z"');
    assert.equal(store.lastTurnTs('last-ts-torn'), '2026-07-27T00:00:03.000Z');
  });

  it('is null for a session with no turns at all', () => {
    assert.equal(store.lastTurnTs('last-ts-none'), null);
  });
});

describe('sessionStartedAt', () => {
  it('prefers the recorded field, which is written once and never moved', () => {
    store.updateMeta('start-meta', { startedAt: '2026-07-27T09:00:00.000Z' });
    store.recordPrompt('start-meta', { text: 'later prompt' });
    assert.equal(store.sessionStartedAt('start-meta'), '2026-07-27T09:00:00.000Z');
  });

  it('falls back to the oldest prompt for a session that predates the field', () => {
    store.ensureSessionDir('start-fallback');
    fs.writeFileSync(
      store.promptsFile('start-fallback'),
      [
        JSON.stringify({ ts: '2026-07-27T08:00:00.000Z', text: 'first' }),
        JSON.stringify({ ts: '2026-07-27T10:00:00.000Z', text: 'second' }),
      ].join('\n') + '\n',
    );
    assert.equal(store.sessionStartedAt('start-fallback'), '2026-07-27T08:00:00.000Z');
  });

  it('returns null rather than now when there is nothing to go on', () => {
    // An unknown session age has to render as absent. Defaulting to the current
    // time would report every fresh session as having just started, which is
    // indistinguishable from the truth and wrong on a resumed one.
    assert.equal(store.sessionStartedAt('start-empty'), null);
  });
});

describe('pruneSessions', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.parse('2026-07-27T00:00:00.000Z');

  function seed(id, ageDays, goal = null) {
    seedTurns(id, 2);
    if (goal) store.writeGoal(id, goal);
    const when = new Date(NOW - ageDays * DAY);
    for (const file of ['turns.jsonl', 'goal.json']) {
      const p = path.join(store.sessionDir(id), file);
      if (fs.existsSync(p)) fs.utimesSync(p, when, when);
    }
  }

  it('never removes a session whose goal is still open, however old', () => {
    seed('prune-active', 400, { objective: 'still going', status: 'active' });
    seed('prune-stale', 400);

    const result = store.pruneSessions({ maxAgeDays: 30, now: NOW });

    assert.ok(result.removed.includes('prune-stale'));
    assert.ok(
      !result.removed.includes('prune-active'),
      'this is exactly the multi-day case the goal system exists to protect',
    );
    assert.ok(fs.existsSync(store.sessionDir('prune-active')));
    assert.ok(!fs.existsSync(store.sessionDir('prune-stale')));
  });

  it('keeps recent sessions', () => {
    seed('prune-recent', 1);
    const result = store.pruneSessions({ maxAgeDays: 30, now: NOW });
    assert.ok(!result.removed.includes('prune-recent'));
  });

  it('reports without deleting when asked to', () => {
    seed('prune-dry', 400);
    const result = store.pruneSessions({ maxAgeDays: 30, dryRun: true, now: NOW });
    assert.ok(result.removed.includes('prune-dry'));
    assert.ok(fs.existsSync(store.sessionDir('prune-dry')), '--dry-run must not delete');
  });

  it('enforces a count ceiling independently of age', () => {
    for (const id of ['cap-a', 'cap-b', 'cap-c']) seed(id, 0);
    const before = store.listSessions().filter((s) => s.goalStatus !== 'active').length;
    assert.ok(before >= 3, 'fixture must have something to cap');

    const result = store.pruneSessions({ maxAgeDays: 0, maxCount: 1, now: NOW });

    // Newest-first, so the ceiling keeps the most recent and drops the rest.
    // A session with an open goal is exempt and still occupies a slot.
    const after = store.listSessions().filter((s) => s.goalStatus !== 'active').length;
    assert.equal(after, 1, 'a ceiling of one keeps exactly the newest prunable session');
    assert.equal(result.removed.length, before - 1);
  });
});
