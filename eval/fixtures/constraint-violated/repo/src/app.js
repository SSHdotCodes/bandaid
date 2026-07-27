'use strict';

// The pinned parser is vendored: it is not published to any registry, so this
// path is the only copy that exists.
const { parse } = require('../vendor/parser');

function main(argv) {
  const parsed = parse(argv.join(' '));
  process.stdout.write(`${JSON.stringify(parsed)}\n`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { main };
