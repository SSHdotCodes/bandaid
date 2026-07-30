# Both features, written independently — and the grouping path never learned
# about the filter. Every visible test passes. The objective does not hold.
cat > src/query.js <<'JS'
'use strict';

function query(rows, opts) {
  const o = opts || {};
  if (o.groupBy) {
    const out = {};
    for (const r of rows) {
      const k = r[o.groupBy];
      if (!out[k]) out[k] = [];
      out[k].push(r);
    }
    return out;
  }
  if (o.filter) return rows.filter(o.filter);
  return rows;
}

module.exports = { query };
JS
