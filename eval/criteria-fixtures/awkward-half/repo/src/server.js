'use strict';

const { allow } = require('./limiter');

function handle(req) {
  if (!allow(req.ip, 100)) return { status: 429 };
  return { status: 200 };
}

module.exports = { handle };
