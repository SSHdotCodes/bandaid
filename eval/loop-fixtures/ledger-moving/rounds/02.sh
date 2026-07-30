set -e
mkdir -p test
cat > test/client.test.js <<'JS'
const assert = require('node:assert/strict');
const { backoffDelays } = require('../src/client.js');
const d = backoffDelays(3);
assert.ok(d[2] > d[1], 'delays must increase');
JS
echo "module.exports = {};" > src/client.js
