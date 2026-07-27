'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-evidence-'));
process.env.BANDAID_HOME = HOME;

const evidence = require('../src/lib/evidence');
const stamp = require('../src/lib/stamp');

const scratch = [];
after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function gitRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-stamp-')));
  scratch.push(dir);
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run('init', '-q');
  run('config', 'user.email', 'test@example.invalid');
  run('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  run('add', '-A');
  run('commit', '-qm', 'first');
  return dir;
}

function plainDir() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-plain-')));
  scratch.push(dir);
  return dir;
}

describe('worktreeStamp', () => {
  it('is stable while nothing changes', () => {
    const repo = gitRepo();
    assert.equal(stamp.worktreeStamp(repo).fp, stamp.worktreeStamp(repo).fp);
    assert.equal(stamp.worktreeStamp(repo).method, 'git');
  });

  it('moves when a tracked file is edited', () => {
    const repo = gitRepo();
    const before = stamp.worktreeStamp(repo).fp;
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    assert.notEqual(stamp.worktreeStamp(repo).fp, before);
  });

  it('moves when a brand-new untracked file appears', () => {
    // The default `git status --porcelain` collapses an untracked directory to
    // one entry, so without -uall a new file inside it would not move the
    // fingerprint — and a probe that never saw it would return a cached pass.
    // A stale result that looks fresh is the worst bug this module can have.
    const repo = gitRepo();
    fs.mkdirSync(path.join(repo, 'scratch'));
    fs.writeFileSync(path.join(repo, 'scratch', 'one.txt'), 'x');
    const before = stamp.worktreeStamp(repo).fp;

    fs.writeFileSync(path.join(repo, 'scratch', 'two.txt'), 'y');
    assert.notEqual(stamp.worktreeStamp(repo).fp, before, 'a new file inside an untracked directory must move the stamp');
  });

  it('moves when a dirty file is edited again', () => {
    // Porcelain says a file is modified, not what it now contains, so two
    // different edits would otherwise share a fingerprint.
    const repo = gitRepo();
    const file = path.join(repo, 'a.txt');
    fs.writeFileSync(file, 'edit one\n');
    const first = stamp.worktreeStamp(repo).fp;
    fs.writeFileSync(file, 'edit two, longer\n');
    assert.notEqual(stamp.worktreeStamp(repo).fp, first);
  });

  it('says it cannot tell outside version control', () => {
    const result = stamp.worktreeStamp(plainDir());
    assert.equal(result.method, 'none');
    assert.equal(result.fp, null);
  });

  it('treats a missing fingerprint as never matching', () => {
    assert.equal(stamp.stampMatches('abc', { fp: null, method: 'none' }), false);
    assert.equal(stamp.stampMatches(null, { fp: 'abc', method: 'git' }), false);
    assert.equal(stamp.stampMatches('abc', { fp: 'abc', method: 'git' }), true);
  });
});

describe('changedPaths', () => {
  it('names what this goal has touched, committed or not', () => {
    const repo = gitRepo();
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'added\n');

    const paths = stamp.changedPaths(repo, base);
    assert.deepEqual(paths, ['a.txt', 'new.txt']);
  });

  it('is null, not empty, when it cannot tell', () => {
    assert.equal(
      stamp.changedPaths(plainDir(), null),
      null,
      '"cannot tell" and "nothing changed" must not be the same value',
    );
  });
});

describe('the evidence ledger', () => {
  const CURRENT = { fp: 'stamp-now', method: 'git' };
  const OLD = { fp: 'stamp-then', method: 'git' };

  function ledger(entries) {
    const cwd = plainDir();
    for (const entry of entries) {
      evidence.append(cwd, { objectiveHash: 'obj1', ...entry }, { byModel: Boolean(entry.byModel) });
    }
    return { cwd, entries: evidence.read(cwd, { objectiveHash: 'obj1' }) };
  }

  it('refuses to let the model record anything as measured', () => {
    const { entries } = ledger([
      { kind: 'check', verdict: 'supported', claim: 'everything is fine, honestly', byModel: true },
    ]);

    assert.equal(entries[0].kind, 'claim', 'whatever it asked for, a model writes a claim');
    assert.equal(entries[0].verdict, 'unverified', 'and a claim is a lead, never a finding');
  });

  it('lets the runtime record what an exit status said', () => {
    const { entries } = ledger([{ kind: 'check', verdict: 'supported', claim: 'npm test exited 0' }]);
    assert.equal(entries[0].kind, 'check');
    assert.equal(entries[0].verdict, 'supported');
  });

  it('keeps records from other objectives out of the way', () => {
    const cwd = plainDir();
    evidence.append(cwd, { objectiveHash: 'obj1', claim: 'mine' });
    evidence.append(cwd, { objectiveHash: 'obj2', claim: 'someone else' });

    const mine = evidence.read(cwd, { objectiveHash: 'obj1' });
    assert.equal(mine.length, 1);
    assert.equal(mine[0].claim, 'mine');
  });

  it('drops empty claims rather than recording noise', () => {
    const cwd = plainDir();
    assert.equal(evidence.append(cwd, { claim: '   ' }), null);
  });

  it('de-duplicates pointers and keeps their order', () => {
    const { entries } = ledger([{ claim: 'x', pointers: ['a.js:1', 'a.js:1', 'cmd:npm test'] }]);
    assert.deepEqual(entries[0].pointers, ['a.js:1', 'cmd:npm test']);
  });
});

describe('coverage', () => {
  const CURRENT = { fp: 'now', method: 'git' };

  const rows = (entries) => evidence.coverage(entries, 4, CURRENT);

  it('counts a measured, current record as covering its criterion', () => {
    const result = rows([{ criterion: 1, kind: 'check', verdict: 'supported', stamp: 'now' }]);
    assert.equal(result[0].state, 'covered');
  });

  it('does not let the engineer cover a criterion by asserting it', () => {
    const result = rows([{ criterion: 2, kind: 'claim', verdict: 'unverified', stamp: 'now' }]);
    assert.equal(result[1].state, 'claimed-only', 'this is the whole point of the ledger');
  });

  it('treats a criterion nobody has said anything about as uncovered', () => {
    assert.equal(rows([])[3].state, 'uncovered');
  });

  it('demotes evidence recorded against an earlier worktree', () => {
    const result = rows([{ criterion: 1, kind: 'check', verdict: 'supported', stamp: 'then' }]);
    assert.equal(result[0].state, 'stale', 'Monday\'s proof says nothing about Thursday\'s worktree');
  });

  it('lets a refutation outrank a passing record on the same criterion', () => {
    const result = rows([
      { criterion: 1, kind: 'check', verdict: 'supported', stamp: 'now' },
      { criterion: 1, kind: 'probe', verdict: 'refuted', stamp: 'now' },
    ]);
    assert.equal(result[0].state, 'refuted');
  });
});

describe('summarize', () => {
  const CURRENT = { fp: 'now', method: 'git' };

  it('reports the score the completion audit asks the model to compute', () => {
    const line = evidence.summarize(
      [
        { criterion: 1, kind: 'check', verdict: 'supported', stamp: 'now' },
        { criterion: 2, kind: 'probe', verdict: 'refuted', stamp: 'now' },
        { criterion: 3, kind: 'claim', verdict: 'unverified', stamp: 'now' },
      ],
      4,
      CURRENT,
    );

    assert.match(line, /1 measured/);
    assert.match(line, /2 refuted/);
    assert.match(line, /3 asserted but not measured/);
    assert.match(line, /4 no evidence/);
  });

  it('says nothing when the goal has no criteria to score', () => {
    assert.equal(evidence.summarize([], 0, CURRENT), '');
  });
});

describe('render', () => {
  const CURRENT = { fp: 'now', method: 'git' };

  it('tells the judge which entries it may believe and which it must check', () => {
    const text = evidence.render(
      [
        { ts: '2026-07-26T14:31:00Z', criterion: 1, kind: 'check', verdict: 'supported', claim: 'npm test exited 0', pointers: ['cmd:npm test'], stamp: 'now' },
        { ts: '2026-07-26T14:02:00Z', criterion: 2, kind: 'claim', verdict: 'unverified', claim: 'the migration is idempotent', pointers: ['src/migrate.js:88'], stamp: 'now' },
      ],
      { currentStamp: CURRENT },
    );

    assert.match(text, /measured/);
    assert.match(text, /engineer/);
    assert.match(text, /go and look at what it points to/);
    assert.match(text, /src\/migrate\.js:88/);
  });

  it('separates what still describes the worktree from what does not', () => {
    const text = evidence.render(
      [
        { ts: '2026-07-25T09:00:00Z', criterion: 1, kind: 'check', verdict: 'supported', claim: 'was true on Monday', pointers: [], stamp: 'then' },
        { ts: '2026-07-27T09:00:00Z', criterion: 1, kind: 'check', verdict: 'refuted', claim: 'is false now', pointers: [], stamp: 'now' },
      ],
      { currentStamp: CURRENT },
    );

    assert.ok(text.indexOf('is false now') < text.indexOf('was true on Monday'), 'current evidence comes first');
    assert.match(text, /Recorded against an earlier state/);
  });

  it('is empty when there is nothing to say, so nobody pays for a feature they are not using', () => {
    assert.equal(evidence.render([], { currentStamp: CURRENT }), '');
  });

  it('keeps fresh entries when the budget forces a choice', () => {
    const many = [];
    for (let i = 0; i < 200; i += 1) {
      many.push({ ts: '2026-07-25T09:00:00Z', criterion: 1, kind: 'check', verdict: 'supported', claim: `stale entry ${i} ${'x'.repeat(200)}`, pointers: [], stamp: 'then' });
    }
    many.push({ ts: '2026-07-27T09:00:00Z', criterion: 1, kind: 'check', verdict: 'refuted', claim: 'the one that matters', pointers: [], stamp: 'now' });

    const text = evidence.render(many, { currentStamp: CURRENT, maxTokens: 400 });
    assert.match(text, /the one that matters/, 'relevance must not be starved by volume');
  });
});

describe('gc', () => {
  it('keeps the newest records and drops the rest', () => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-gc-')));
    scratch.push(cwd);
    for (let i = 0; i < 20; i += 1) evidence.append(cwd, { claim: `entry ${i}` });

    assert.equal(evidence.gc(cwd, { maxRecords: 5 }), 15);
    const left = evidence.read(cwd);
    assert.equal(left.length, 5);
    assert.equal(left[4].claim, 'entry 19');
  });

  it('does nothing to a file already within its bound', () => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-gc2-')));
    scratch.push(cwd);
    evidence.append(cwd, { claim: 'only one' });
    assert.equal(evidence.gc(cwd, { maxRecords: 5 }), 0);
  });
});
