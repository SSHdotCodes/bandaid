'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { report } = require('../src/report');

const rows = [
  { name: 'alpha', count: 2 },
  { name: 'beta', count: 5 },
];

test('--json emits a parseable object with one entry per row', () => {
  const parsed = JSON.parse(report(rows, { json: true }));
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows[0], { name: 'alpha', count: 2 });
  assert.equal(typeof parsed.rows[1].count, 'number');
});

test('the text rendering is unchanged without the flag', () => {
  assert.equal(report(rows), 'alpha\t2\nbeta\t5');
});
