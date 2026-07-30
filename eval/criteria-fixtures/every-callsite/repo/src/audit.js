'use strict';

// The third caller, in a file the obvious grep for "report|ingest" misses.
const parse = require('./parse');

module.exports.check = (csv) => parse.parseLegacy(csv).length;
