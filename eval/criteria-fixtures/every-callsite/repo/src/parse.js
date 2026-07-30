'use strict';

/** @deprecated use parseNext */
function parseLegacy(text) {
  return String(text).split(',');
}

function parseNext(text, { trim = true } = {}) {
  const parts = String(text).split(',');
  return trim ? parts.map((p) => p.trim()) : parts;
}

module.exports = { parseLegacy, parseNext };
