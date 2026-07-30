'use strict';

// In-memory only. There is no Redis client here yet, and no fallback path.
const counts = new Map();

function allow(key, limit) {
  const n = (counts.get(key) || 0) + 1;
  counts.set(key, n);
  return n <= limit;
}

module.exports = { allow };
