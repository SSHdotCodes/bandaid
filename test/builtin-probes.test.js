'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SECRETS = path.join(ROOT, 'src', 'probes', 'secrets.js');
const SWEEP = path.join(ROOT, 'src', 'probes', 'sweep.js');
const LOAD = path.join(ROOT, 'src', 'probes', 'load.js');

const scratch = [];
after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function workdir({ git = true, files = {} } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-builtin-')));
  scratch.push(dir);
  // git needs something to commit, and every probe here wants a base commit.
  const seeded = Object.keys(files).length ? files : { 'seed.txt': 'seed\n' };
  for (const [name, body] of Object.entries(seeded)) {
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

function head(dir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function runProbe(script, dir, env = {}) {
  const result = spawnSync(process.execPath, [script], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, ...env },
  });
  let detail = null;
  const lines = String(result.stdout || '').trim().split('\n');
  try {
    detail = JSON.parse(lines[lines.length - 1]);
  } catch {
    /* not every path prints structured output */
  }
  return { exit: result.status, detail, stderr: String(result.stderr || '') };
}

describe('the secrets probe', () => {
  const KEY = `AKIA${'IOSFODNN7EXAMPL'}E`;

  it('passes when this work introduced nothing', () => {
    const dir = workdir({ files: { 'app.js': 'const x = 1;\n' } });
    const result = runProbe(SECRETS, dir, { BANDAID_BASE_SHA: head(dir) });
    assert.equal(result.exit, 0);
    assert.equal(result.detail.metrics.hits, 0);
  });

  it('fails on a credential added to a tracked file', () => {
    const dir = workdir({ files: { 'app.js': 'const x = 1;\n' } });
    const base = head(dir);
    fs.appendFileSync(path.join(dir, 'app.js'), `const key = "${KEY}";\n`);

    const result = runProbe(SECRETS, dir, { BANDAID_BASE_SHA: base });
    assert.equal(result.exit, 1);
    assert.match(result.detail.findings[0].message, /AWS access key id at app\.js:2/);
  });

  it('fails on a credential in a brand-new untracked file', () => {
    // A new file is in no diff at all, and it is exactly where a credential
    // lands.
    const dir = workdir({ files: { 'app.js': 'const x = 1;\n' } });
    fs.writeFileSync(path.join(dir, '.env.local'), `ghp_${'0'.repeat(36)}\n`);

    assert.equal(runProbe(SECRETS, dir, { BANDAID_BASE_SHA: head(dir) }).exit, 1);
  });

  it('does not fail on a credential this goal never touched', () => {
    // Blocking a goal on somebody else's old mistake is how a gate gets
    // switched off within a day.
    const dir = workdir({ files: { 'old.js': `const key = "${KEY}";\n` } });
    assert.equal(runProbe(SECRETS, dir, { BANDAID_BASE_SHA: head(dir) }).exit, 0);
  });

  it('does not report removing one as introducing one', () => {
    const dir = workdir({ files: { 'app.js': `const key = "${KEY}";\n` } });
    const base = head(dir);
    fs.writeFileSync(path.join(dir, 'app.js'), 'const key = process.env.KEY;\n');

    assert.equal(runProbe(SECRETS, dir, { BANDAID_BASE_SHA: base }).exit, 0);
  });

  it('honours an allowlist, so a fixture with a fake key is not a permanent failure', () => {
    const dir = workdir({ files: { 'app.js': 'x\n' } });
    fs.writeFileSync(path.join(dir, 'fixture.json'), `{"key":"${KEY}"}\n`);
    fs.mkdirSync(path.join(dir, '.bandaid'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.bandaid', 'secrets-allow.txt'), 'fixture.json  # a deliberate fake\n');

    assert.equal(runProbe(SECRETS, dir, { BANDAID_BASE_SHA: head(dir) }).exit, 0);
  });

  it('abstains rather than passing when there is no git to diff against', () => {
    const dir = workdir({ git: false, files: { 'app.js': `const k = "${KEY}";\n` } });
    const result = runProbe(SECRETS, dir);
    assert.equal(result.exit, 78, 'no evidence is not the same as no problem');
  });
});

describe('the sweep probe', () => {
  function withFindings(findings) {
    const dir = workdir({ files: { 'app.js': 'x\n' } });
    fs.mkdirSync(path.join(dir, '.bandaid', 'artifacts', 'sweep'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.bandaid', 'artifacts', 'sweep', 'findings.json'),
      JSON.stringify({ schema: 'bandaid.sweep/1', findings }),
    );
    return dir;
  }

  const graded = (dir) =>
    JSON.parse(fs.readFileSync(path.join(dir, '.bandaid', 'artifacts', 'sweep', 'findings.json'), 'utf8')).findings;

  it('abstains when nobody has swept', () => {
    assert.equal(runProbe(SWEEP, workdir()).exit, 78);
  });

  it('confirms a finding whose reproduction actually fails', () => {
    const dir = withFindings([
      { id: 'sw-1', title: 'real bug', pointer: 'src/a.js:1', repro: { command: 'exit 1' } },
    ]);
    const result = runProbe(SWEEP, dir);

    assert.equal(result.exit, 1);
    assert.equal(graded(dir)[0].status, 'confirmed');
  });

  it('discards one whose reproduction passes, which is the hallucination filter', () => {
    const dir = withFindings([
      { id: 'sw-2', title: 'imagined', pointer: 'src/b.js:1', status: 'confirmed', repro: { command: 'exit 0' } },
    ]);
    const result = runProbe(SWEEP, dir);

    assert.equal(result.exit, 0);
    assert.equal(
      graded(dir)[0].status,
      'discarded-unreproducible',
      'the runtime overrides what the finding claimed about itself',
    );
  });

  it('discards a finding that shipped no reproduction at all', () => {
    const dir = withFindings([{ id: 'sw-3', title: 'vibes', pointer: 'src/c.js:1' }]);
    assert.equal(runProbe(SWEEP, dir).exit, 0);
    assert.equal(graded(dir)[0].status, 'discarded-no-repro');
  });

  it('does not let a finding mark itself confirmed', () => {
    const dir = withFindings([
      { id: 'sw-4', title: 'self-declared', status: 'confirmed', reproExit: 1, repro: { command: 'exit 0' } },
    ]);
    runProbe(SWEEP, dir);
    assert.equal(graded(dir)[0].status, 'discarded-unreproducible');
    assert.equal(graded(dir)[0].reproExit, 0, 'the exit status is measured, not accepted');
  });

  it('accepts a dismissal only when it carries a reason', () => {
    const dir = withFindings([{ id: 'sw-5', title: 'known', repro: { command: 'exit 1' } }]);
    const allow = path.join(dir, '.bandaid', 'sweep-allow.json');

    fs.writeFileSync(allow, JSON.stringify([{ id: 'sw-5' }]));
    assert.equal(runProbe(SWEEP, dir).exit, 1, 'a dismissal with no reason is not a dismissal');

    fs.writeFileSync(allow, JSON.stringify([{ id: 'sw-5', reason: 'legacy path, deleted in #412' }]));
    assert.equal(runProbe(SWEEP, dir).exit, 0);
  });

  it('passes cleanly when the sweep found nothing', () => {
    assert.equal(runProbe(SWEEP, withFindings([])).exit, 0);
  });
});

describe('the load probe', () => {
  // The server has to live in its own process: `runProbe` uses spawnSync, which
  // blocks this event loop, so a server listening here could never accept the
  // probe's connections.
  let server;
  let url;

  before(async () => {
    server = spawn(
      process.execPath,
      [
        '-e',
        `require('node:http').createServer((q, s) => { s.writeHead(200, {'content-type':'text/plain'}); s.end('ok'); })
           .listen(0, '127.0.0.1', function () { process.stdout.write(String(this.address().port) + '\\n'); });`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
      server.stdout.once('data', (chunk) => {
        clearTimeout(timer);
        resolve(String(chunk).trim());
      });
    });
    url = `http://127.0.0.1:${port}/`;
  });

  after(() => server && server.kill());

  function withBudget(budget) {
    const dir = workdir({ git: false });
    fs.mkdirSync(path.join(dir, '.bandaid'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.bandaid', 'load-budgets.json'), JSON.stringify(budget));
    return dir;
  }

  it('abstains without a budget, because an ungraded load test is telemetry', () => {
    const result = runProbe(LOAD, workdir({ git: false }));
    assert.equal(result.exit, 78);
    assert.match(result.stderr, /telemetry, not a verifier/);
  });

  it('abstains when the service is not running, rather than blaming the code', () => {
    const dir = withBudget({ target: 'http://127.0.0.1:9/', durationSec: 1, concurrency: 1 });
    assert.equal(runProbe(LOAD, dir).exit, 78);
  });

  it('passes inside a budget it can meet', () => {
    const dir = withBudget({ target: url, durationSec: 1, concurrency: 4, p95Ms: 2000, errorRate: 0.5, minRps: 1 });
    const result = runProbe(LOAD, dir);
    assert.equal(result.exit, 0);
    assert.ok(result.detail.metrics.rps > 0);
  });

  it('fails a budget it cannot, and names which one', () => {
    const dir = withBudget({ target: url, durationSec: 1, concurrency: 4, minRps: 100000000 });
    const result = runProbe(LOAD, dir);
    assert.equal(result.exit, 1);
    assert.match(result.detail.findings[0].message, /rps .* is under 100000000/);
  });
});
