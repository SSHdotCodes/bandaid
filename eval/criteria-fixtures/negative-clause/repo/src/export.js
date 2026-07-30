'use strict';

const COLUMNS = ['id', 'name', 'email', 'created_at'];

function toCsv(rows) {
  let out = COLUMNS.join(',') + '\n';
  for (const row of rows) {
    // Quadratic string building, one row at a time.
    out += COLUMNS.map((c) => String(row[c] ?? '')).join(',') + '\n';
  }
  return out;
}

module.exports = { COLUMNS, toCsv };
