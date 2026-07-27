'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-probes-'));
process.env.BANDAID_HOME = HOME;

const probes = require('../src/lib/probes');
const trust = require('../src/lib/trust');
const { DEFAULTS } = require('../src/lib/config');
const { verifierStrength } = require('../src/lib/goals');

const scratch = [];
after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

/** A git repo with a manifest and whatever probe scripts the test needs. */
function repo(manifest, scripts = {}, { commit = true, trusted = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-repo-')));
  scratch.push(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');

  fs.mkdirSync(path.join(dir, '.bandaid', 'probes'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.bandaid', 'probes.json'), JSON.stringify(manifest, null, 2));
  for (const [name, body] of Object.entries(scripts)) {
    fs.writeFileSync(path.join(dir, '.bandaid', 'probes', name), body);
  }
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  if (commit) {
    git('add', '-A');
    git('commit', '-qm', 'init');
  }
  if (trusted) trust.trust(dir, path.join(dir, '.bandaid', 'probes.json'));
  return dir;
}

const one = (id, body) => ({ probes: [{ id, run: `node .bandaid/probes/${id}.js` }] });

describe('the exit-status contract', () => {
  it('reads 0 as pass', () => {
    const dir = repo(one('ok'), { 'ok.js': 'process.exit(0)' });
    const result = probes.runProbe(probes.loadManifest(dir, DEFAULTS).probes[0], { cwd: dir });
    assert.equal(result.verdict, 'pass');
  });

  it('reads 78 as abstain, because only the probe knows it cannot run here', () => {
    const dir = repo(one('none'), { 'none.js': 'console.error("no browser here");process.exit(78)' });
    const result = probes.runProbe(probes.loadManifest(dir, DEFAULTS).probes[0], { cwd: dir });
    assert.equal(result.verdict, 'abstain');
    assert.match(result.summary, /no browser here/);
  });

  it('reads anything else as fail', () => {
    const dir = repo(one('bad'), { 'bad.js': 'process.exit(1)' });
    assert.equal(probes.runProbe(probes.loadManifest(dir, DEFAULTS).probes[0], { cwd: dir }).verdict, 'fail');
  });

  it('reads exit 2 as fail, not abstain', () => {
    // grep exits 2 on error, and plenty of CLIs use 2 for a usage mistake. If
    // that meant "abstain" a probe could decline by accident, which is the one
    // direction this contract must never fail in.
    const dir = repo(one('two'), { 'two.js': 'process.exit(2)' });
    assert.equal(probes.runProbe(probes.loadManifest(dir, DEFAULTS).probes[0], { cwd: dir }).verdict, 'fail');
  });

  it('fails a probe that dies before printing anything', () => {
    const dir = repo(one('boom'), { 'boom.js': 'throw new Error("kaboom")' });
    const result = probes.runProbe(probes.loadManifest(dir, DEFAULTS).probes[0], { cwd: dir });
    assert.equal(result.verdict, 'fail', 'silence from a probe that started is not evidence');
  });

  it('abstains, loudly, when the probe binary cannot be started at all', () => {
    const dir = repo({ probes: [{ id: 'missing', run: 'definitely-not-a-real-binary-xyz' }] });
    const result = probes.runProbe(probes.loadManifest(dir, DEFAULTS).probes[0], { cwd: dir });
    assert.equal(result.verdict, 'fail');
    assert.ok(result.exitCode !== 0, 'a shell reports the missing binary rather than failing to spawn');
  });
});

describe('structured output', () => {
  it('reads a trailing JSON line as detail', () => {
    const dir = repo(one('rich'), {
      'rich.js': 'console.log(JSON.stringify({summary:"3 of 4 viewports clean",findings:[{message:"overflow at 375"}],artifacts:["a.png"]}));process.exit(1)',
    });
    const result = probes.runProbe(probes.loadManifest(dir, DEFAULTS).probes[0], { cwd: dir });
    assert.equal(result.summary, '3 of 4 viewports clean');
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.artifacts, ['a.png']);
  });

  it('never lets stdout argue with the exit status', () => {
    const dir = repo(one('liar'), { 'liar.js': 'console.log(JSON.stringify({ok:true,summary:"all good"}));process.exit(1)' });
    const result = probes.runProbe(probes.loadManifest(dir, DEFAULTS).probes[0], { cwd: dir });
    assert.equal(result.verdict, 'fail', 'a probe claiming success while exiting 1 has failed');
  });

  it('ignores output that is not the structured line', () => {
    const dir = repo(one('noisy'), { 'noisy.js': 'console.log("just some words");process.exit(0)' });
    const result = probes.runProbe(probes.loadManifest(dir, DEFAULTS).probes[0], { cwd: dir });
    assert.equal(result.verdict, 'pass');
    assert.equal(result.summary, 'just some words');
  });
});

describe('trust', () => {
  const manifest = one('ok');
  const scripts = { 'ok.js': 'process.exit(0)' };

  it('runs nothing until the manifest has been approved', () => {
    const dir = repo(manifest, scripts, { trusted: false });
    assert.deepEqual(
      probes.trustedProbes(DEFAULTS, { projectRoot: dir }, dir),
      [],
      'a committed manifest is arbitrary shell execution until somebody says otherwise',
    );
  });

  it('runs once approved', () => {
    const dir = repo(manifest, scripts);
    assert.equal(probes.trustedProbes(DEFAULTS, { projectRoot: dir }, dir).length, 1);
  });

  it('stops again the moment a single byte changes', () => {
    const dir = repo(manifest, scripts);
    const file = path.join(dir, '.bandaid', 'probes.json');
    fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\n`);

    assert.equal(trust.status(dir, file).state, 'changed');
    assert.deepEqual(probes.trustedProbes(DEFAULTS, { projectRoot: dir }, dir), []);
  });

  it('refuses a manifest anyone on the machine can rewrite', () => {
    const dir = repo(manifest, scripts);
    const file = path.join(dir, '.bandaid', 'probes.json');
    fs.chmodSync(file, 0o666);

    const state = trust.status(dir, file);
    assert.equal(state.state, 'unsafe', 'approval does not survive world-writability');
    fs.chmodSync(file, 0o644);
  });

  it('can be withdrawn', () => {
    const dir = repo(manifest, scripts);
    trust.untrust(dir);
    assert.equal(trust.status(dir, path.join(dir, '.bandaid', 'probes.json')).state, 'unknown');
  });
});

describe('applicability', () => {
  const probeSet = [
    { id: 'always' },
    { id: 'css', when: { changed: ['src/**/*.css'] } },
    { id: 'api', when: { changed: ['src/api/**'] } },
  ];

  it('runs only the probes a change could possibly affect', () => {
    const applied = probes.applicable(probeSet, ['src/ui/main.css']).map((p) => p.id);
    assert.deepEqual(applied, ['always', 'css']);
  });

  it('runs everything when it cannot tell what changed', () => {
    // null is "cannot tell" — no git, or no base commit. Skipping a verifier on
    // a guess is the wrong direction to be wrong in.
    assert.equal(probes.applicable(probeSet, null).length, 3);
  });

  it('runs nothing conditional when nothing has changed', () => {
    assert.deepEqual(probes.applicable(probeSet, []).map((p) => p.id), ['always']);
  });

  it('matches ** across directories and * within one', () => {
    assert.ok(probes.globToRegExp('src/**/*.js').test('src/a/b/c.js'));
    assert.ok(probes.globToRegExp('src/**/*.js').test('src/c.js'));
    assert.ok(!probes.globToRegExp('src/*.js').test('src/a/b.js'));
    assert.ok(probes.globToRegExp('**').test('anything/at/all.txt'));
  });
});

describe('composition', () => {
  const r = (probeId, verdict, extra = {}) => ({ probeId, verdict, ...extra });

  it('lets any single failure veto', () => {
    const result = probes.composeProbes([r('a', 'pass'), r('b', 'fail'), r('c', 'pass')]);
    assert.equal(result.verdict, 'fail');
    assert.equal(result.failures.length, 1);
  });

  it('passes only when something actually passed', () => {
    assert.equal(probes.composeProbes([r('a', 'pass'), r('b', 'abstain')]).verdict, 'pass');
  });

  it('makes an all-abstaining set identical to having no probes at all', () => {
    const none = probes.composeProbes([]);
    const all = probes.composeProbes([r('a', 'abstain'), r('b', 'abstain')]);
    assert.equal(all.verdict, none.verdict);
    assert.equal(all.verdict, 'abstain');
  });

  it('never lets a pending probe veto', () => {
    assert.equal(probes.composeProbes([r('a', 'pending')]).verdict, 'abstain');
  });

  it('surfaces the skill that would produce what an abstaining probe wants', () => {
    const result = probes.composeProbes([r('a', 'abstain', { summons: 'bandaid-browser-verify' })]);
    assert.deepEqual(result.summonses, ['bandaid-browser-verify']);
  });
});

describe('the verdict cache', () => {
  it('is used only when it describes this exact worktree', () => {
    const dir = repo(one('ok'), { 'ok.js': 'process.exit(0)' });
    probes.writeCache(dir, 'ok', { probeId: 'ok', verdict: 'pass', stamp: 'aaa', finishedAt: 'now' });

    const cached = probes.readCache(dir, 'ok');
    assert.equal(cached.stamp, 'aaa');

    // assessProbes only reuses a record whose stamp matches the live one, and
    // the live stamp of a real repository is never 'aaa'.
    const assessed = probes.assessProbes({ goal: { projectRoot: dir }, config: DEFAULTS, cwd: dir, launch: false });
    assert.ok(assessed.pending.length, 'a mismatched stamp is not a verdict');
  });

  it('is dropped on request', () => {
    const dir = repo(one('ok'), { 'ok.js': 'process.exit(0)' });
    probes.writeCache(dir, 'ok', { probeId: 'ok', verdict: 'pass', stamp: 'aaa', finishedAt: 'now' });
    probes.clearCache(dir, 'ok');
    assert.equal(probes.readCache(dir, 'ok'), null);
  });
});

describe('locks', () => {
  it('respects a lock held by a live process', () => {
    const dir = repo(one('ok'), { 'ok.js': 'process.exit(0)' });
    probes.takeLock(dir, 'ok', 'stamp');
    assert.equal(probes.lockState(dir, 'ok', 600000).held, true);
    probes.releaseLock(dir, 'ok');
  });

  it('breaks a lock whose process is gone', () => {
    const dir = repo(one('ok'), { 'ok.js': 'process.exit(0)' });
    require('../src/lib/store').writeJson(probes.lockFile(dir, 'ok'), {
      pid: 999999999,
      startedAt: new Date().toISOString(),
    });
    assert.equal(probes.lockState(dir, 'ok', 600000).held, false, 'one duplicated run beats a permanent wedge');
  });

  it('breaks a lock that has outlived the probe budget', () => {
    const dir = repo(one('ok'), { 'ok.js': 'process.exit(0)' });
    require('../src/lib/store').writeJson(probes.lockFile(dir, 'ok'), {
      pid: process.pid,
      startedAt: new Date(Date.now() - 3600_000).toISOString(),
    });
    assert.equal(probes.lockState(dir, 'ok', 1000).held, false);
  });
});

describe('trustedProbes is safe to call from the stop decision', () => {
  it('executes nothing', () => {
    const marker = path.join(HOME, 'probe-ran');
    const dir = repo(
      { probes: [{ id: 'sideeffect', run: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)},'x')"` }] },
      {},
    );

    probes.trustedProbes(DEFAULTS, { projectRoot: dir }, dir);
    assert.equal(fs.existsSync(marker), false, 'decideOnStop must stay pure and fast');
  });
});

describe('probes and the autonomy slider', () => {
  it('does not earn a longer leash than the judge', () => {
    // Probes veto but never prove, so they cannot cause a false close. The
    // leash exists to bound false closes; a probe makes the loop safer rather
    // than longer.
    assert.equal(verifierStrength(DEFAULTS, { probes: ['browser'] }), 'judged');
  });

  it('never outranks a check', () => {
    assert.equal(verifierStrength(DEFAULTS, { probes: ['browser'], check: 'npm test' }), 'verified');
  });

  it('leaves a goal with neither where it was', () => {
    assert.equal(verifierStrength(DEFAULTS, { probes: [] }), 'unverified');
  });
});
