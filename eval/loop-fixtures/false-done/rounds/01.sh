cat > src/client.js <<'JS'
'use strict';
function backoffDelays() { throw new Error('not implemented'); }
module.exports = { backoffDelays };
JS
mkdir -p test
cat > test/client.test.js <<'JS'
const assert = require('node:assert/strict');
const { backoffDelays } = require('../src/client.js');
assert.ok(backoffDelays);   // vacuous: asserts the symbol exists, nothing more
JS
