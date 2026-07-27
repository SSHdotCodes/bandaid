'use strict';

function renderText(rows) {
  return rows.map((row) => `${row.name}\t${row.count}`).join('\n');
}

function renderJson(rows) {
  return JSON.stringify({ rows: rows.map((row) => ({ name: row.name, count: row.count })) });
}

function report(rows, { json = false } = {}) {
  return json ? renderJson(rows) : renderText(rows);
}

function main(argv) {
  const rows = [
    { name: 'alpha', count: 2 },
    { name: 'beta', count: 5 },
  ];
  process.stdout.write(`${report(rows, { json: argv.includes('--json') })}\n`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { renderJson, renderText, report };
