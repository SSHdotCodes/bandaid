cat > src/client.js <<'JS'
'use strict';
function backoffDelays(n) { return Array.from({ length: n }, (_, i) => 100 * 2 ** i); }
module.exports = { backoffDelays };
JS
