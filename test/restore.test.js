'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { DEFAULTS } = require('../src/lib/config');
const { buildRestoreBlock, selectWithinBudget } = require('../src/lib/restore');

const getText = (item) => item.text;

describe('selectWithinBudget — Codex build_compacted_history_with_limit', () => {
  it('spends the budget newest-first but returns chronological order', () => {
    const items = [{ text: 'a'.repeat(40) }, { text: 'b'.repeat(40) }, { text: 'c'.repeat(40) }];
    // 40 bytes = 10 tokens each; a 25-token budget covers two whole items.
    const { selected, droppedCount } = selectWithinBudget(items, 25, getText);

    assert.equal(selected.length, 3, 'the boundary item is included, truncated');
    assert.equal(droppedCount, 0);
    assert.ok(selected[1].text.startsWith('b'));
    assert.ok(selected[2].text.startsWith('c'), 'newest item ends up last');
    assert.equal(selected[2].truncated, false, 'newest items are kept whole');
    assert.equal(selected[0].truncated, true, 'the oldest kept item absorbs the truncation');
  });

  it('drops the oldest items entirely once the budget is spent', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ text: `${i}`.repeat(40) }));
    const { selected, droppedCount } = selectWithinBudget(items, 20, getText);

    assert.equal(selected.length + droppedCount, 10);
    assert.ok(droppedCount > 0, 'older items fall outside the budget');
    assert.ok(selected.at(-1).text.startsWith('9'), 'the newest item is always kept');
  });

  it('keeps nothing at a zero budget', () => {
    const { selected, droppedCount } = selectWithinBudget([{ text: 'x' }], 0, getText);
    assert.equal(selected.length, 0);
    assert.equal(droppedCount, 1);
  });

  it('handles an empty history', () => {
    const { selected, droppedCount } = selectWithinBudget([], 100, getText);
    assert.equal(selected.length, 0);
    assert.equal(droppedCount, 0);
  });
});

describe('buildRestoreBlock', () => {
  const prompts = [
    { ts: '2026-01-01T00:00:00Z', text: 'Build the parser. Never use regex for this.' },
    { ts: '2026-01-01T00:05:00Z', text: 'Also add tests.' },
  ];
  const batches = [
    {
      turnIndex: 1,
      calls: [{ name: 'Grep', input: '/parse/ in src', result: 'src/parser.js:42: function parse()', failed: false }],
    },
  ];

  it('reproduces user instructions word for word', () => {
    const { text } = buildRestoreBlock({ prompts, batches, config: DEFAULTS });
    assert.ok(text.includes('Build the parser. Never use regex for this.'));
    assert.ok(text.includes('Also add tests.'));
  });

  it('carries tool parameters and results, not just tool names', () => {
    const { text } = buildRestoreBlock({ prompts, batches, config: DEFAULTS });
    assert.ok(text.includes('/parse/ in src'), 'call arguments survive');
    assert.ok(text.includes('src/parser.js:42'), 'call results survive');
  });

  it('numbers messages against the true total so drops are visible', () => {
    const { text, stats } = buildRestoreBlock({ prompts, batches, config: DEFAULTS });
    assert.match(text, /<user-message n="1" of="2"/);
    assert.equal(stats.promptsKept, 2);
    assert.equal(stats.promptsDropped, 0);
  });

  it('reports which older messages fell outside a tight budget', () => {
    const tight = { ...DEFAULTS, compact: { ...DEFAULTS.compact, userMessageMaxTokens: 4, digestBudgetTokens: 0 } };
    const { stats } = buildRestoreBlock({ prompts, batches, config: tight });
    assert.ok(stats.promptsDropped >= 1);
  });

  it('includes an open goal and omits a closed one', () => {
    const open = buildRestoreBlock({ prompts, batches, config: DEFAULTS, goal: { status: 'active', objective: 'Ship v1' } });
    assert.ok(open.text.includes('Ship v1'));

    const closed = buildRestoreBlock({ prompts, batches, config: DEFAULTS, goal: { status: 'complete', objective: 'Ship v1' } });
    assert.ok(!closed.text.includes('Ship v1'));
  });

  it('returns null when there is nothing to restore', () => {
    assert.equal(buildRestoreBlock({ prompts: [], batches: [], config: DEFAULTS }), null);
  });

  it('omits digests when turn recording is off', () => {
    const noTurns = { ...DEFAULTS, compact: { ...DEFAULTS.compact, recordTurns: false } };
    const { text } = buildRestoreBlock({ prompts, batches, config: noTurns });
    assert.ok(!text.includes('turn-tool-digests'));
    assert.ok(text.includes('Build the parser'), 'prompts are still restored');
  });
});
