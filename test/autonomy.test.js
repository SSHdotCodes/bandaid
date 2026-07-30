'use strict';

/**
 * The permission-ask classifier.
 *
 * One failure matters far more than the other, and these tests are shaped around
 * that. Blocking a genuine question traps the user in a loop where the question is
 * never asked — the failure the original one-line check existed to prevent.
 * Allowing a permission-ask is today's behaviour and costs a typed "continue".
 *
 * So the corpus test gates on "no genuine question was blocked" and merely reports
 * how many permission-asks were caught.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const { classifyTrailingQuestion, matchesBlocker, trailingLine } = require('../src/lib/autonomy');

const CORPUS = path.join(__dirname, '..', 'eval', 'autonomy-fixtures', 'questions.jsonl');

const cases = fs
  .readFileSync(CORPUS, 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const kindOf = (text, opts) => classifyTrailingQuestion(text, opts).kind;
const allows = (text, opts) => kindOf(text, opts) !== 'permission';

describe('the corpus', () => {
  it('never blocks a genuine question — the gate, and it is not negotiable', () => {
    const blocked = cases.filter((c) => c.expect === 'genuine' && !allows(c.text));
    assert.deepEqual(
      blocked.map((c) => c.text),
      [],
      'a blocked genuine question locks the user out of their own session',
    );
  });

  it('catches most permission-asks, and a miss is only the old behaviour', () => {
    const permission = cases.filter((c) => c.expect === 'permission');
    const caught = permission.filter((c) => !allows(c.text));
    // A floor, not a target. Raising it must never come at the cost of the gate above.
    assert.ok(
      caught.length / permission.length >= 0.85,
      `caught ${caught.length}/${permission.length}`,
    );
  });

  it('has both classes represented, so neither test is vacuous', () => {
    assert.ok(cases.filter((c) => c.expect === 'genuine').length >= 8);
    assert.ok(cases.filter((c) => c.expect === 'permission').length >= 8);
  });
});

describe('classifyTrailingQuestion', () => {
  it('blocks the canonical permission slip', () => {
    assert.equal(kindOf('Should I proceed?'), 'permission');
    assert.equal(kindOf('Shall I proceed?'), 'permission');
    assert.equal(kindOf('Want me to keep going?'), 'permission');
  });

  it('allows a question about a value only the user has', () => {
    assert.equal(kindOf('What should the retry limit be?'), 'genuine');
    assert.equal(kindOf('I need an API key for staging — do you have one?'), 'genuine');
  });

  it('reads the question, not the punctuation — a line with no question mark is not one', () => {
    assert.equal(kindOf('I will proceed with the migration.'), 'unknown');
    assert.equal(kindOf(''), 'unknown');
    assert.equal(kindOf(null), 'unknown');
  });

  it('falls through to allow when it recognises nothing', () => {
    // The whole design: uncertainty resolves to the old behaviour.
    assert.equal(kindOf('Is the moon made of cheese?'), 'unknown');
    assert.ok(allows('Is the moon made of cheese?'));
  });

  it('sees offer phrasing wrapped around a real question as genuine', () => {
    // The adversarial case in both directions. "Would you like me to" is the
    // permission-ask idiom, but there is a real question underneath here.
    assert.equal(kindOf('Would you like me to use the staging key, or do you have a production one?'), 'genuine');
    // And choice phrasing around work that is entirely in scope is a permission-ask.
    assert.ok(allows('Should I do the tests first or the docs first?'), 'a miss here costs one turn, which is acceptable');
  });

  it('only looks at the last line, where a closing question lives', () => {
    const message = 'Should I proceed?\n\nI have finished the refactor and all tests pass.';
    assert.equal(kindOf(message), 'unknown', 'the trailing line is a statement');
  });

  it('treats a question overlapping a recorded blocker as genuine, whatever its shape', () => {
    const blockers = ['confirming the retry timing needs a live upstream this session cannot reach'];
    // Phrased as a permission-ask, but it is about something already recorded as
    // impossible from here — which the model told us, unprompted, on an earlier turn.
    assert.equal(
      classifyTrailingQuestion('Should I proceed without the live upstream retry timing?', { blockers }).matched,
      'blocker',
    );
    assert.equal(kindOf('Should I proceed without the live upstream retry timing?', { blockers }), 'genuine');
  });
});

describe('matchesBlocker', () => {
  it('needs two substantial words in common, not one', () => {
    assert.ok(matchesBlocker('what about the staging websocket endpoint?', ['the staging websocket endpoint needs a VPN']));
    assert.ok(!matchesBlocker('should i continue?', ['the staging websocket endpoint needs a VPN']));
  });

  it('ignores short words, which match everything', () => {
    assert.ok(!matchesBlocker('is it the one for you?', ['it is the one for you and me']));
  });

  it('is false with no blockers recorded', () => {
    assert.ok(!matchesBlocker('anything?', []));
    assert.ok(!matchesBlocker('anything?', null));
  });
});

describe('trailingLine', () => {
  it('skips blank lines to find the real last line', () => {
    assert.equal(trailingLine('done\n\n  \nShall I proceed?\n\n'), 'Shall I proceed?');
  });

  it('is empty for nothing', () => {
    assert.equal(trailingLine(''), '');
    assert.equal(trailingLine(null), '');
  });
});
