mkdir -p test
cat > test/client.test.js <<'JS'
const assert = require('node:assert/strict');
const { backoffDelays } = require('../src/client.js');
const d = backoffDelays(4);
for (let i = 1; i < d.length; i++) assert.ok(d[i] > d[i - 1]);
JS
