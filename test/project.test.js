'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-project-'));
process.env.BANDAID_HOME = HOME;

const project = require('../src/lib/project');
const { DEFAULTS } = require('../src/lib/config');
const goals = require('../src/lib/goals');
const store = require('../src/lib/store');

const REPO = path.resolve(__dirname, '..');
const scratch = [];

after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpdir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

describe('projectRoot', () => {
  it('resolves to the repository root, not the directory Claude was started in', () => {
    const fromRoot = project.projectRoot(REPO);
    const fromSub = project.projectRoot(path.join(REPO, 'src', 'lib'));
    assert.equal(fromSub, fromRoot, 'running from a subdirectory must not be a different project');
    assert.equal(fromRoot, REPO);
  });

  it('falls back to the directory itself outside version control', () => {
    const plain = tmpdir('bandaid-plain-');
    assert.equal(project.projectRoot(plain), plain);
  });

  it('never throws on a directory that does not exist', () => {
    assert.doesNotThrow(() => project.projectRoot('/nope/not/here'));
  });

  it('gives two different repositories two different keys', () => {
    const other = tmpdir('bandaid-other-');
    assert.notEqual(project.projectKey(REPO), project.projectKey(other));
  });

  it('gives the same repository the same key from anywhere inside it', () => {
    assert.equal(project.projectKey(REPO), project.projectKey(path.join(REPO, 'test')));
  });
});

describe('handoff', () => {
  it('is null until an objective has been recorded', () => {
    assert.equal(project.readHandoff(tmpdir('bandaid-empty-')), null);
  });

  it('records the objective, the bar, and the walls', () => {
    const cwd = tmpdir('bandaid-handoff-');
    project.writeHandoff(cwd, 's1', {
      objective: 'Port the retry logic',
      criteria: ['backoff exists'],
      criteriaSource: 'model',
      constraints: ['do not touch vendor/'],
      blockers: ['needs a GPU'],
      blockedStreak: 1,
      check: 'npm test',
      baseSha: 'a'.repeat(40),
      status: 'active',
      source: 'explicit',
      createdAt: '2026-07-26T09:00:00.000Z',
      continuations: 3,
    });

    const record = project.readHandoff(cwd);
    assert.equal(record.goal.objective, 'Port the retry logic');
    assert.deepEqual(record.goal.criteria, ['backoff exists']);
    assert.deepEqual(record.goal.constraints, ['do not touch vendor/']);
    assert.deepEqual(record.goal.blockers, ['needs a GPU']);
    assert.equal(record.goal.blockedStreak, 1, 'an adopted goal must not get a fresh budget for a standing wall');
    assert.equal(record.goal.check, 'npm test');
    assert.deepEqual(record.goal.sessions, ['s1']);
  });

  it('chains the sessions that have worked one objective', () => {
    const cwd = tmpdir('bandaid-chain-');
    const goal = { objective: 'Same objective', status: 'active', createdAt: '2026-07-26T09:00:00.000Z' };
    project.writeHandoff(cwd, 's1', goal);
    project.writeHandoff(cwd, 's2', goal);
    project.writeHandoff(cwd, 's2', goal);

    assert.deepEqual(project.readHandoff(cwd).goal.sessions, ['s1', 's2'], 'each session once, in order');
  });

  it('starts a fresh chain when the objective changes', () => {
    const cwd = tmpdir('bandaid-newobj-');
    project.writeHandoff(cwd, 's1', { objective: 'First', status: 'active', createdAt: 'x' });
    project.writeHandoff(cwd, 's2', { objective: 'Second', status: 'active', createdAt: 'y' });

    const record = project.readHandoff(cwd);
    assert.equal(record.goal.objective, 'Second');
    assert.deepEqual(record.goal.sessions, ['s2'], 'a new objective is not a continuation of the old one');
  });

  it('keeps the original creation time across sessions', () => {
    const cwd = tmpdir('bandaid-created-');
    const goal = { objective: 'Long one', status: 'active', createdAt: '2026-07-20T09:00:00.000Z' };
    project.writeHandoff(cwd, 's1', goal);
    project.writeHandoff(cwd, 's2', { ...goal, createdAt: '2026-07-27T09:00:00.000Z' });

    assert.equal(
      project.readHandoff(cwd).goal.createdAt,
      '2026-07-20T09:00:00.000Z',
      'age is measured from when the objective was set, not from the latest session',
    );
  });

  it('is cleared only when asked', () => {
    const cwd = tmpdir('bandaid-clear-');
    project.writeHandoff(cwd, 's1', { objective: 'Gone soon', status: 'active', createdAt: 'x' });
    project.clearHandoff(cwd);
    assert.equal(project.readHandoff(cwd), null);
  });
});

describe('saveGoal mirrors the objective to its project', () => {
  it('writes a handoff without the caller carrying a cwd', () => {
    const cwd = tmpdir('bandaid-mirror-');
    goals.setGoal('mirror-1', 'Migrate the tokenizer', { source: 'explicit', cwd });

    const record = project.readHandoff(cwd);
    assert.equal(record.goal.objective, 'Migrate the tokenizer');
    assert.equal(record.sessionId, 'mirror-1');
  });

  it('follows the goal through to completion', () => {
    const cwd = tmpdir('bandaid-mirror2-');
    goals.setGoal('mirror-2', 'Finish the thing', { source: 'explicit', cwd });
    goals.closeGoal('mirror-2', 'complete');

    assert.equal(project.readHandoff(cwd).goal.status, 'complete');
  });
});

describe('adoptHandoff', () => {
  function seed(cwd, session = 'seed') {
    goals.setGoal(session, 'Port the retry logic, do not touch vendor/', { source: 'explicit', cwd, check: 'npm test' });
    goals.setCriteria(session, ['backoff exists', 'retryLegacy is gone']);
    goals.addBlocker(session, 'the staging endpoint needs a VPN');
    return cwd;
  }

  it('carries the bar across unchanged and the budget across fresh', () => {
    const cwd = seed(tmpdir('bandaid-adopt-'));
    const before = goals.loadGoal('seed');
    goals.saveGoal('seed', { ...before, continuations: 5 });

    const adopted = goals.adoptHandoff('adopt-target', cwd, DEFAULTS);

    assert.deepEqual(adopted.criteria, ['backoff exists', 'retryLegacy is gone']);
    assert.deepEqual(adopted.constraints, before.constraints);
    assert.deepEqual(adopted.blockers, before.blockers);
    assert.equal(adopted.blockedStreak, 1);
    assert.equal(adopted.check, 'npm test');
    assert.equal(adopted.continuations, 0, 'a new day earns a fresh continuation budget');
    assert.equal(adopted.maxContinuations, 8, 'and it is re-resolved against the adopted verifier');
    assert.equal(adopted.baseSha, before.baseSha, 'the diff base spans every day the goal ran');
    assert.equal(adopted.createdAt, before.createdAt);
    assert.equal(adopted.adoptedFrom, 'seed');
  });

  it('refuses when the session already has a goal', () => {
    const cwd = seed(tmpdir('bandaid-adopt2-'), 'seed-2');
    goals.setGoal('busy', 'Something else entirely', { source: 'explicit', cwd: REPO });

    assert.equal(goals.adoptHandoff('busy', cwd, DEFAULTS), null, 'a live objective beats a remembered one');
    assert.equal(goals.loadGoal('busy').objective, 'Something else entirely');
  });

  it('refuses to resurrect a closed objective', () => {
    const cwd = seed(tmpdir('bandaid-adopt3-'), 'seed-3');
    goals.closeGoal('seed-3', 'complete');

    assert.equal(goals.adoptHandoff('later', cwd, DEFAULTS), null);
  });

  it('is null when the project has no record at all', () => {
    assert.equal(goals.adoptHandoff('nobody', tmpdir('bandaid-adopt4-'), DEFAULTS), null);
  });
});

describe('per-cwd session pointers', () => {
  it('keeps one pointer per session so two in a directory stay distinguishable', () => {
    const cwd = tmpdir('bandaid-pointer-');
    store.setCurrentSession('ptr-a', cwd);
    store.setCurrentSession('ptr-b', cwd);

    const seen = store.sessionsForCwd(cwd).map((s) => s.sessionId).sort();
    assert.deepEqual(seen, ['ptr-a', 'ptr-b']);
    assert.equal(store.getCurrentSession(cwd), 'ptr-b', 'latest still resolves for the unambiguous case');
  });

  it('reports the ambiguity rather than picking one', () => {
    const cwd = tmpdir('bandaid-ambig-');
    store.setCurrentSession('amb-a', cwd);
    store.setCurrentSession('amb-b', cwd);

    assert.equal(store.ambiguousSessions(cwd).length, 2);
  });

  it('does not call a single session ambiguous', () => {
    const cwd = tmpdir('bandaid-single-');
    store.setCurrentSession('solo', cwd);
    assert.deepEqual(store.ambiguousSessions(cwd), []);
  });

  it('ignores sessions that have gone quiet', () => {
    const cwd = tmpdir('bandaid-quiet-');
    store.setCurrentSession('old', cwd);
    store.setCurrentSession('new', cwd);

    // Two hours on, only one of them prompted recently.
    const later = Date.now() + 2 * 60 * 60 * 1000;
    assert.deepEqual(store.ambiguousSessions(cwd, { now: later }), []);
  });

  it('still finds the live session written by an older layout', () => {
    const cwd = tmpdir('bandaid-legacy-');
    const crypto = require('node:crypto');
    const key = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 16);
    store.writeJson(path.join(HOME, 'current', `${key}.json`), {
      sessionId: 'legacy-one',
      cwd,
      ts: new Date().toISOString(),
    });

    assert.equal(store.getCurrentSession(cwd), 'legacy-one', 'an upgrade must not lose the running session');
  });
});

describe('ageInDays', () => {
  const NOW = Date.parse('2026-07-27T12:00:00.000Z');

  it('counts whole days', () => {
    assert.equal(project.ageInDays('2026-07-27T09:00:00.000Z', NOW), 0);
    assert.equal(project.ageInDays('2026-07-26T09:00:00.000Z', NOW), 1);
    assert.equal(project.ageInDays('2026-07-20T09:00:00.000Z', NOW), 7);
  });

  it('is null rather than a number when there is no timestamp', () => {
    assert.equal(project.ageInDays(null, NOW), null);
    assert.equal(project.ageInDays('not a date', NOW), null);
  });

  it('never goes negative on a clock that moved backwards', () => {
    assert.equal(project.ageInDays('2026-07-28T09:00:00.000Z', NOW), 0);
  });
});

describe('git-rooted projects', () => {
  it('treats a nested repository as its own project', () => {
    const outer = tmpdir('bandaid-outer-');
    const inner = path.join(outer, 'vendor', 'lib');
    fs.mkdirSync(inner, { recursive: true });
    for (const dir of [outer, inner]) {
      execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    }

    assert.notEqual(
      project.projectKey(inner),
      project.projectKey(outer),
      'a vendored repository is not the same project as its host',
    );
  });
});
