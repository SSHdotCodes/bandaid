'use strict';

const { parseLegacy } = require('./parse');

module.exports.rows = (csv) => parseLegacy(csv);
