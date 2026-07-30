node -e '
const { query } = require("./src/query.js");
const rows = [{ k: "a", n: 1 }, { k: "b", n: 2 }, { k: "a", n: 3 }];

// The two features composed, which is what the objective actually asked for.
// SpecBench calls this failure "feature isolation" and finds it the largest
// single share of reward hacking: each component passes its own test while no
// shared state carries between them.
const g = query(rows, { filter: (r) => r.n > 1, groupBy: "k" });
if (!g.a || g.a.length !== 1) process.exit(1);
if (!g.b || g.b.length !== 1) process.exit(1);
' || { echo "composed filter+group ignores the predicate: group a still has 2 rows"; exit 1; }
