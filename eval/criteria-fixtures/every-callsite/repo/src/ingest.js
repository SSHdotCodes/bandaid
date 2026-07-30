'use strict';

const { parseLegacy } = require('./parse');

module.exports.load = (csv) => parseLegacy(csv).filter(Boolean);
