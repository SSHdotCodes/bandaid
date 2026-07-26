'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { DEFAULTS } = require('../src/lib/config');
const { decideOnStop, endsWithQuestionToUser, isGoalWorthy, newGoal, turnWasTrivial } = require('../src/lib/goals');

const editBatch = [{ calls: [{ name: 'Edit', input: 'src/a.js', result: 'ok' }] }];
const readBatch = [{ calls: [{ name: 'Read', input: 'src/a.js', result: 'contents' }] }];

describe('isGoalWorthy', () => {
  it('accepts real instructions', () => {
    assert.equal(isGoalWorthy('Refactor the parser to drop the regex path'), true);
  });

  it('rejects acknowledgements and noise', () => {
    for (const chatter of ['thanks', 'ok', 'yes', 'Perfect!', 'ty', '']) {
      assert.equal(isGoalWorthy(chatter), false, `${JSON.stringify(chatter)} should not become a goal`);
    }
  });
});

describe('endsWithQuestionToUser', () => {
  it('detects a closing question', () => {
    assert.equal(endsWithQuestionToUser('Done. Want me to also update the docs?'), true);
  });

  it('ignores a question mark that is not the last line', () => {
    assert.equal(endsWithQuestionToUser('Why was it slow? An N+1 query. Fixed.'), false);
    assert.equal(endsWithQuestionToUser('Is it done?\n\nYes — all tests pass.'), false);
  });

  it('is false for empty input', () => {
    assert.equal(endsWithQuestionToUser(''), false);
    assert.equal(endsWithQuestionToUser(null), false);
  });
});

describe('turnWasTrivial', () => {
  it('is false when the turn changed something', () => {
    assert.equal(turnWasTrivial(editBatch), false);
  });

  it('is true for a read-only turn', () => {
    assert.equal(turnWasTrivial(readBatch), true);
    assert.equal(turnWasTrivial([]), true);
  });
});

describe('decideOnStop', () => {
  const base = { config: DEFAULTS, stopHookActive: false, recentBatches: editBatch };

  it('blocks the stop while an active goal has continuations left', () => {
    const goal = newGoal('Ship the feature');
    const decision = decideOnStop({ ...base, goal });
    assert.equal(decision.action, 'continue');
  });

  it('respects stop_hook_active so it can never loop', () => {
    const goal = newGoal('Ship the feature');
    const decision = decideOnStop({ ...base, goal, stopHookActive: true });
    assert.equal(decision.action, 'allow');
    assert.equal(decision.reason, 'stop_hook_active');
  });

  it('stops blocking once the continuation budget is spent', () => {
    const goal = { ...newGoal('Ship the feature'), continuations: 2, maxContinuations: 2 };
    const decision = decideOnStop({ ...base, goal });
    assert.equal(decision.action, 'wrap-up');
  });

  it('lets a read-only turn end untouched', () => {
    const goal = newGoal('Explain the architecture');
    const decision = decideOnStop({ ...base, goal, recentBatches: readBatch });
    assert.equal(decision.action, 'allow');
    assert.equal(decision.reason, 'turn changed nothing');
  });

  it('audits a read-only turn when skipTrivialTurns is off', () => {
    const config = { ...DEFAULTS, goals: { ...DEFAULTS.goals, skipTrivialTurns: false } };
    const decision = decideOnStop({ ...base, config, goal: newGoal('Explain the architecture'), recentBatches: readBatch });
    assert.equal(decision.action, 'continue');
  });

  it('never blocks when the model is asking the user a question', () => {
    const decision = decideOnStop({
      ...base,
      goal: newGoal('Ship the feature'),
      lastAssistantMessage: 'I can migrate this two ways. Should I keep the legacy endpoint alive?',
    });
    assert.equal(decision.action, 'allow');
    assert.equal(decision.reason, 'model is asking the user a question');
  });

  it('still blocks when the answer merely mentions a question mark mid-text', () => {
    const decision = decideOnStop({
      ...base,
      goal: newGoal('Ship the feature'),
      lastAssistantMessage: 'You asked "why is it slow?" — the cause was an N+1 query. Fixed and tests pass.',
    });
    assert.equal(decision.action, 'continue');
  });

  it('never blocks without a goal', () => {
    assert.equal(decideOnStop({ ...base, goal: null }).action, 'allow');
  });

  it('never blocks a goal that is already closed', () => {
    for (const status of ['complete', 'blocked', 'budget_limited', 'abandoned']) {
      const goal = { ...newGoal('Ship it'), status };
      assert.equal(decideOnStop({ ...base, goal }).action, 'allow', `status ${status} should allow the stop`);
    }
  });

  it('honours the global kill switch', () => {
    const off = { ...DEFAULTS, enabled: false };
    assert.equal(decideOnStop({ ...base, config: off, goal: newGoal('Ship it') }).action, 'allow');
  });

  it('honours goals.mode = off', () => {
    const off = { ...DEFAULTS, goals: { ...DEFAULTS.goals, mode: 'off' } };
    assert.equal(decideOnStop({ ...base, config: off, goal: newGoal('Ship it') }).action, 'allow');
  });

  it('treats maxContinuations = 0 as disabled', () => {
    const goal = { ...newGoal('Ship it'), maxContinuations: 0 };
    assert.equal(decideOnStop({ ...base, goal }).action, 'allow');
  });
});
