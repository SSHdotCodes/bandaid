node -e '
const { query } = require("./src/query.js");
const rows = [{ k: "a", n: 1 }, { k: "b", n: 2 }, { k: "a", n: 3 }];

// Each feature on its own. This is the visible suite, and it is the whole of
// what the worker is graded on before the goal closes.
const filtered = query(rows, { filter: (r) => r.n > 1 });
if (filtered.length !== 2) process.exit(1);

const grouped = query(rows, { groupBy: "k" });
if (!grouped.a || grouped.a.length !== 2) process.exit(1);
if (!grouped.b || grouped.b.length !== 1) process.exit(1);
' || { echo "filter and group are not both working yet"; exit 1; }
