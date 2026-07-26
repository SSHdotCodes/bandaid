'use strict';
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { backoffDelays, request } = require('../src/client');

describe('retry', () => {
  it('grows the delay between attempts', () => {
    const delays = backoffDelays(4, 50);
    assert.deepEqual(delays, [50, 100, 200, 400]);
    for (let i = 1; i < delays.length; i += 1) assert.ok(delays[i] > delays[i - 1]);
  });

  it('retries a failing call and eventually succeeds', async () => {
    let calls = 0;
    const slept = [];
    const result = await request(async () => { calls += 1; if (calls < 3) throw new Error('boom'); return 'ok'; },
      { attempts: 4, base: 10, sleep: async (ms) => slept.push(ms) });
    assert.equal(result, 'ok');
    assert.deepEqual(slept, [10, 20]);
  });
});
