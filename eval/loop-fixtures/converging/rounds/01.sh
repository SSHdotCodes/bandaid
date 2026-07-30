cat > src/client.js <<'JS'
'use strict';
function backoffDelays(n) { return new Array(n).fill(100); }
module.exports = { backoffDelays };
JS
