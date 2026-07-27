'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-selfcheck-'));
process.env.BANDAID_HOME = HOME;

const selfcheck = require('../src/lib/selfcheck');

const scratch = [];
after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function workdir({ git = false, files = {} } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-sc-')));
  scratch.push(dir);
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  if (git) {
    const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    run('init', '-q');
    run('config', 'user.email', 'test@example.invalid');
    run('config', 'user.name', 'Test');
    run('add', '-A');
    run('commit', '-qm', 'init');
  }
  return dir;
}

function baseSha(dir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

describe('addExpectation', () => {
  it('records a command prediction', () => {
    const list = selfcheck.addExpectation([], { command: 'grep -c foo a.js', says: '0' });
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, 'command');
    assert.equal(list[0].says, '0');
  });

  it('records a file prediction', () => {
    const list = selfcheck.addExpectation([], { file: 'src/a.js', contains: 'retry' });
    assert.equal(list[0].kind, 'file');
  });

  it('refuses an empty one', () => {
    assert.equal(selfcheck.addExpectation([], {}), null);
    assert.equal(selfcheck.addExpectation([], { command: '   ' }), null);
  });

  it('does not record the same prediction twice', () => {
    const once = selfcheck.addExpectation([], { command: 'true', says: 'x' });
    const twice = selfcheck.addExpectation(once, { command: 'true', says: 'x' });
    assert.equal(twice.length, 1);
  });
});

describe('runExpectations', () => {
  it('abstains when none were recorded, which must look like the feature not existing', () => {
    const result = selfcheck.runExpectations({ expectations: [] }, { cwd: workdir() });
    assert.equal(result.verdict, 'abstain');
  });

  it('passes when the prediction holds', () => {
    const dir = workdir({ files: { 'a.txt': 'hello\n' } });
    const goal = { expectations: [{ kind: 'command', command: 'grep -c hello a.txt', says: '1' }] };
    assert.equal(selfcheck.runExpectations(goal, { cwd: dir }).verdict, 'pass');
  });

  it('fails with what it actually said, which is the whole value', () => {
    const dir = workdir({ files: { 'a.txt': 'goodbye\n' } });
    const goal = { expectations: [{ kind: 'command', command: 'grep -c hello a.txt', says: '1' }] };

    const result = selfcheck.runExpectations(goal, { cwd: dir });
    assert.equal(result.verdict, 'fail');
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].actual, '0');
  });

  it('treats a command that will not run as a failed prediction, not an excuse', () => {
    const dir = workdir();
    const goal = { expectations: [{ kind: 'command', command: 'definitely-not-a-binary-xyz' }] };
    assert.equal(selfcheck.runExpectations(goal, { cwd: dir }).verdict, 'fail');
  });

  it('checks file contents too', () => {
    const dir = workdir({ files: { 'src/a.js': 'function retry() {}\n' } });
    assert.equal(
      selfcheck.runExpectations({ expectations: [{ kind: 'file', file: 'src/a.js', contains: 'retry' }] }, { cwd: dir })
        .verdict,
      'pass',
    );
    assert.equal(
      selfcheck.runExpectations({ expectations: [{ kind: 'file', file: 'src/a.js', contains: 'backoff' }] }, { cwd: dir })
        .verdict,
      'fail',
    );
  });

  it('reports a missing file rather than throwing', () => {
    const dir = workdir();
    const result = selfcheck.runExpectations({ expectations: [{ kind: 'file', file: 'nope.js' }] }, { cwd: dir });
    assert.equal(result.verdict, 'fail');
    assert.match(result.failures[0].actual, /does not exist/);
  });

  it('ignores whitespace differences, because a prediction is about the answer', () => {
    const dir = workdir({ files: { 'a.txt': 'x\n' } });
    const goal = { expectations: [{ kind: 'command', command: 'echo "  1  "', says: '1' }] };
    assert.equal(selfcheck.runExpectations(goal, { cwd: dir }).verdict, 'pass');
  });
});

describe('checkScope', () => {
  it('abstains when no scope was declared', () => {
    assert.equal(selfcheck.checkScope({ scope: [] }, { cwd: workdir() }).verdict, 'abstain');
  });

  it('abstains when git cannot say what changed, rather than calling it a violation', () => {
    const dir = workdir({ files: { 'a.txt': 'x' } });
    assert.equal(
      selfcheck.checkScope({ scope: ['src/**'] }, { cwd: dir }).verdict,
      'abstain',
      'an unknown answer must never read as a breach',
    );
  });

  it('passes when every change is inside the declared paths', () => {
    const dir = workdir({ git: true, files: { 'src/a.js': 'one\n' } });
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'two\n');

    const result = selfcheck.checkScope({ scope: ['src/**'], baseSha: baseSha(dir) }, { cwd: dir });
    assert.equal(result.verdict, 'pass');
  });

  it('names the files that went outside it', () => {
    const dir = workdir({ git: true, files: { 'src/a.js': 'one\n', 'billing/b.js': 'one\n' } });
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'two\n');
    fs.writeFileSync(path.join(dir, 'billing', 'b.js'), 'two\n');

    const result = selfcheck.checkScope({ scope: ['src/**'], baseSha: baseSha(dir) }, { cwd: dir });
    assert.equal(result.verdict, 'fail');
    assert.deepEqual(result.violations, ['billing/b.js']);
  });

  it('catches a brand-new file dropped outside the scope', () => {
    const dir = workdir({ git: true, files: { 'src/a.js': 'one\n' } });
    fs.writeFileSync(path.join(dir, 'sneaky.js'), 'new\n');

    const result = selfcheck.checkScope({ scope: ['src/**'], baseSha: baseSha(dir) }, { cwd: dir });
    assert.deepEqual(result.violations, ['sneaky.js']);
  });
});

describe('the expectation tier inside assess', () => {
  const { assess } = require('../src/lib/verify');
  const { DEFAULTS } = require('../src/lib/config');

  it('vetoes a stop when a prediction stopped holding, even with the check green', () => {
    const dir = workdir({ files: { 'a.txt': 'goodbye\n' } });
    const goal = {
      objective: 'x',
      check: 'true',
      expectations: [{ kind: 'command', command: 'grep -c hello a.txt', says: '1' }],
    };

    const result = assess({ goal, config: DEFAULTS, cwd: dir });
    assert.equal(result.proven, false);
    assert.equal(result.verification.source, 'expect');
    assert.match(result.reason, /expectation failed/);
  });

  it('is invisible when the goal recorded none', () => {
    const dir = workdir();
    const result = assess({ goal: { objective: 'x', check: 'true' }, config: DEFAULTS, cwd: dir });
    assert.equal(result.proven, true, 'nobody pays for a feature they are not using');
  });
});
