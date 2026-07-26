'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');

const goals = require('../src/lib/goals');
const { continuationPrompt, criteriaSection } = require('../src/lib/prompts');
const { judgePrompt } = require('../src/lib/verify');
const { buildRestoreBlock } = require('../src/lib/restore');
const { DEFAULTS } = require('../src/lib/config');

let home;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-criteria-'));
  process.env.BANDAID_HOME = home;
});

after(() => {
  delete process.env.BANDAID_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('normalizeCriteria', () => {
  it('trims, collapses whitespace, and drops empties', () => {
    assert.deepEqual(goals.normalizeCriteria(['  npm   test exits 0 ', '', '   ', null]), ['npm test exits 0']);
  });

  it('de-duplicates case-insensitively, so a repeat cannot pad the bar', () => {
    assert.deepEqual(goals.normalizeCriteria(['Tests pass', 'tests pass']), ['Tests pass']);
  });

  it('survives a non-array', () => {
    assert.deepEqual(goals.normalizeCriteria('tests pass'), []);
    assert.deepEqual(goals.normalizeCriteria(undefined), []);
  });
});

describe('goal criteria storage', () => {
  it('records the source when criteria arrive with the goal', () => {
    const goal = goals.newGoal('Ship it', { source: 'explicit', criteria: ['tests pass'] });
    assert.deepEqual(goal.criteria, ['tests pass']);
    assert.equal(goal.criteriaSource, 'explicit');
  });

  it('leaves criteriaSource null when there are none', () => {
    assert.equal(goals.newGoal('Ship it').criteriaSource, null);
  });

  it('attaches criteria to an auto-mode goal that started without any', () => {
    goals.setGoal('sess-attach', 'Ship it', { source: 'auto' });
    const updated = goals.setCriteria('sess-attach', ['npm test exits 0']);
    assert.deepEqual(updated.criteria, ['npm test exits 0']);
    assert.equal(updated.criteriaSource, 'model');
  });

  it('refuses to move the bar once it is fixed', () => {
    goals.setGoal('sess-fixed', 'Ship it', { source: 'auto', criteria: ['the hard thing works'] });
    const after = goals.setCriteria('sess-fixed', ['something easier']);
    assert.deepEqual(after.criteria, ['the hard thing works'], 'a later turn must not lower the bar');
  });

  it('allows an explicit replace', () => {
    goals.setGoal('sess-replace', 'Ship it', { source: 'auto', criteria: ['first'] });
    const after = goals.setCriteria('sess-replace', ['second'], { replace: true });
    assert.deepEqual(after.criteria, ['second']);
  });

  it('ignores an empty write rather than clearing the bar', () => {
    goals.setGoal('sess-empty', 'Ship it', { source: 'auto', criteria: ['keep me'] });
    assert.deepEqual(goals.setCriteria('sess-empty', []).criteria, ['keep me']);
  });

  it('returns null for a session with no goal', () => {
    assert.equal(goals.setCriteria('sess-absent', ['x']), null);
  });
});

describe('criteria reach every consumer', () => {
  const goal = { ...goals.newGoal('Port the retry logic', { criteria: ['npm test exits 0', 'no old helper left'] }), continuations: 1 };
  const opts = { completeCommand: 'CMD', criteriaCommand: 'CRIT' };

  it('renders numbered and escaped', () => {
    const text = criteriaSection({ criteria: ['handles <script> input'] });
    assert.match(text, /1\. handles &lt;script&gt; input/);
  });

  it('renders nothing when there are none', () => {
    assert.equal(criteriaSection({ criteria: [] }), '');
    assert.equal(criteriaSection(null), '');
  });

  it('puts the fixed list in the continuation prompt and grades against it', () => {
    const text = continuationPrompt(goal, opts);
    assert.match(text, /<acceptance-criteria>/);
    assert.match(text, /1\. npm test exits 0/);
    assert.match(text, /Grade each acceptance criterion above on its own/);
    assert.doesNotMatch(text, /Derive concrete requirements from the objective/);
  });

  it('asks the model to fix the bar exactly once, when none is recorded', () => {
    const bare = continuationPrompt({ ...goal, criteria: [] }, opts);
    assert.match(bare, /no recorded acceptance criteria/);
    assert.match(bare, /CRIT/);
    assert.match(bare, /Derive concrete requirements from the objective/);

    assert.doesNotMatch(continuationPrompt(goal, opts), /no recorded acceptance criteria/);
  });

  it('gives the judge the same rubric the worker is graded on', () => {
    const text = judgePrompt({ objective: 'Port the retry logic', criteria: ['npm test exits 0'] });
    assert.match(text, /<acceptance-criteria>\n1\. npm test exits 0\n<\/acceptance-criteria>/);
    assert.match(text, /Judge against these and only these/);
    assert.doesNotMatch(judgePrompt({ objective: 'x' }), /acceptance-criteria/);
  });

  it('carries the bar through a compaction', () => {
    const block = buildRestoreBlock({
      prompts: [{ text: 'do the thing', ts: '2026-07-26T00:00:00Z' }],
      batches: [],
      config: DEFAULTS,
      goal: { ...goal, status: 'active' },
    });
    assert.match(block.text, /It is done when all of these are true, and not before:/);
    assert.match(block.text, /1\. npm test exits 0/);
  });
});
