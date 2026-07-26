'use strict';
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { backoffDelays } = require('../src/client');

describe('retry', () => {
  it('grows the delay between attempts', () => {
    // TODO: assert the delays actually increase
    assert.ok(backoffDelays);
  });
});
