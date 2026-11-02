// GET /api/summary  - pending returns grouped by supplier (A-Z), oldest RPO date first,
// undated items last in each group. Same output shape as the old getSummaryReport():
// [ { supplier, rows: [ ... ] } ]
const { route } = require('../lib/core');
const { query } = require('../lib/core');
const { RETURN_COLUMNS } = require('../lib/core');

module.exports = route(['GET'], async function () {
  const rows = await query(`
    SELECT ${RETURN_COLUMNS}
    FROM returns
    WHERE status = 'PENDING'
    ORDER BY rpo_date ASC NULLS LAST, id ASC`);

  // Grouped and sorted in JS (not SQL) so supplier order is identical to the old app,
  // independent of the database's collation.
  const groups = new Map();
  rows.forEach(function (row) {
    const key = String(row.supplier || '').trim() || '(No Supplier)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });

  return Array.from(groups.keys())
    .sort()
    .map(function (name) {
      return { supplier: name, rows: groups.get(name) };
    });
});
