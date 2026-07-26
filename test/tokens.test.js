'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  approxTokenCount,
  splitBudget,
  truncateMiddleChars,
  truncateMiddleWithTokenBudget,
} = require('../src/lib/tokens');

describe('approxTokenCount', () => {
  it('is ceil(bytes / 4), matching Codex', () => {
    assert.equal(approxTokenCount(''), 0);
    assert.equal(approxTokenCount('abcd'), 1);
    assert.equal(approxTokenCount('abcde'), 2);
    assert.equal(approxTokenCount('a'.repeat(4000)), 1000);
  });

  it('counts bytes, not code points', () => {
    // "é" is two UTF-8 bytes; a naive length check would say 1 token for 4 chars.
    assert.equal(approxTokenCount('é'.repeat(4)), 2);
  });
});

describe('splitBudget', () => {
  it('gives the odd byte to the tail, matching Codex', () => {
    assert.deepEqual(splitBudget(10), [5, 5]);
    assert.deepEqual(splitBudget(11), [5, 6]);
  });
});

describe('truncateMiddleWithTokenBudget', () => {
  it('returns the input untouched when it fits', () => {
    const { text, originalTokens } = truncateMiddleWithTokenBudget('hello world', 100);
    assert.equal(text, 'hello world');
    assert.equal(originalTokens, null);
  });

  it('keeps the head and the tail and reports the original size', () => {
    const input = `${'A'.repeat(500)}${'B'.repeat(500)}`;
    const { text, originalTokens } = truncateMiddleWithTokenBudget(input, 20);

    assert.ok(text.startsWith('A'), 'head is preserved');
    assert.ok(text.endsWith('B'), 'tail is preserved');
    assert.match(text, /…\d+ tokens truncated…/);
    assert.equal(originalTokens, 250);
  });

  it('never splits a multi-byte character', () => {
    const input = '☃'.repeat(400);
    const { text } = truncateMiddleWithTokenBudget(input, 10);
    assert.ok(!text.includes('�'), 'no replacement characters');
  });

  it('degrades to a bare marker at a zero budget', () => {
    const { text } = truncateMiddleWithTokenBudget('x'.repeat(100), 0);
    assert.match(text, /^…\d+ tokens truncated…$/);
  });

  it('reports chars rather than tokens in the byte-budget variant', () => {
    const out = truncateMiddleChars('y'.repeat(200), 40);
    assert.match(out, /…\d+ chars truncated…/);
  });
});
