// GET /api/summary  - every pending return as one flat list (see the sort note below). Each row carries its outlet.
const { route, scopeOf, SCOPE_SQL } = require('../lib/core');
const { query } = require('../lib/core');
const { RETURN_COLUMNS } = require('../lib/core');

module.exports = route(['GET'], async function (req) {
  const rows = await query(`
    SELECT ${RETURN_COLUMNS}
    FROM returns
    WHERE status = 'PENDING' AND ${SCOPE_SQL(1)}
    ORDER BY rpo_date ASC NULLS LAST, id ASC`, [scopeOf(req)]);

  // One flat list, ordered outlet -> supplier (A-Z) -> oldest RPO date first (undated last). Sorted in JS (not SQL) so the order is
  // identical to the old app, independent of the database's collation. The page groups by outlet when it is showing all outlets.
  const key = (r) => String(r.supplier || '').trim() || '(No Supplier)';
  return rows.map((r) => Object.assign(r, { supplier: key(r), outlet: r.outlet || '' }))
    .sort((a, b) => (a.outlet < b.outlet ? -1 : a.outlet > b.outlet ? 1 : 0) || (a.supplier < b.supplier ? -1 : a.supplier > b.supplier ? 1 : 0));
});
