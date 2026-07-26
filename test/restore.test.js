'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { DEFAULTS } = require('../src/lib/config');
const { buildRestoreBlock, looksLikeCorrection, renderDigestBlock, selectWithinBudget } = require('../src/lib/restore');

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

describe('relevance pinning', () => {
  it('recognises corrections and leaves ordinary requests alone', () => {
    for (const text of ["don't touch the vendored files", 'use fetch instead of axios', 'actually, revert that']) {
      assert.equal(looksLikeCorrection(text), true, `${JSON.stringify(text)} should pin`);
    }
    for (const text of ['add a retry to the client', 'ship the parser', '']) {
      assert.equal(looksLikeCorrection(text), false, `${JSON.stringify(text)} should not pin`);
    }
  });

  it('keeps a binding correction that pure recency would have evicted', () => {
    const prompts = [
      { text: "never edit anything under vendor/, it is generated" },
      ...Array.from({ length: 12 }, (_, i) => ({ text: `then do routine step ${i} `.repeat(6) })),
    ];
    const budget = 60;

    const recencyOnly = selectWithinBudget(prompts, budget, getText);
    assert.ok(
      !recencyOnly.selected.some((s) => s.index === 0),
      'precondition: recency alone drops the oldest message at this budget',
    );

    const pinned = selectWithinBudget(prompts, budget, getText, { isPinned: (p) => looksLikeCorrection(p.text) });
    const kept = pinned.selected.find((s) => s.index === 0);
    assert.ok(kept, 'the constraint survives');
    assert.equal(kept.truncated, false, 'and survives whole');
    assert.ok(pinned.selected.at(-1).index === prompts.length - 1, 'the newest message is still kept too');
  });

  it('never lets pinned items take more than half the budget', () => {
    const prompts = Array.from({ length: 20 }, () => ({ text: "don't do that ".repeat(20) }));
    const { tokensUsed } = selectWithinBudget(prompts, 200, getText, { isPinned: () => true });
    assert.ok(tokensUsed <= 200, 'total stays inside the budget');
    const pinnedOnly = selectWithinBudget(prompts, 200, getText, {
      isPinned: (_, i) => i < 10,
    });
    assert.ok(pinnedOnly.selected.some((s) => s.index >= 10), 'recent items still get a share');
  });

  it('keeps failed turns that would otherwise age out of the digest budget', () => {
    const batches = [
      // `failed` is set by buildCallRecords when the batch is recorded, so this
      // is the shape the real ledger holds.
      {
        turnIndex: 1,
        calls: [{ name: 'Bash', input: 'npm run migrate', result: 'Error: relation already exists', failed: true }],
      },
      ...Array.from({ length: 8 }, (_, i) => ({
        turnIndex: i + 2,
        calls: [{ name: 'Read', input: `src/file${i}.js`, result: 'x'.repeat(400) }],
      })),
    ];

    const { text } = renderDigestBlock(batches, [], { digestBudgetTokens: 220, turnDigestMaxTokens: 20000 });
    assert.match(text, /\[FAILED\]/, 'the failure is still in the digest');
    assert.match(text, /npm run migrate/, 'with the command that produced it');
  });

  it('pins the prompt the goal was made from', () => {
    const objective = 'Port the retry logic to the new client';
    const prompts = [
      { text: objective },
      ...Array.from({ length: 12 }, (_, i) => ({ text: `unrelated follow-up ${i} `.repeat(6) })),
    ];
    const tight = { ...DEFAULTS, compact: { ...DEFAULTS.compact, userMessageMaxTokens: 60, digestBudgetTokens: 0 } };

    const { text } = buildRestoreBlock({
      prompts,
      batches: [],
      config: tight,
      goal: { status: 'active', objective, criteria: [] },
    });
    assert.ok(text.includes(objective), 'the originating prompt survives verbatim');
  });
});
