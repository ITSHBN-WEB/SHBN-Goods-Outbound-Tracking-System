// GET  /api/returns  -> list of all PENDING returns (Update Return screen)
// POST /api/returns  -> body { entries: [ {supplier, department, brand, rpoNo, totalItem,
//                        totalCarton, rpoDate (yyyy-mm-dd), reason, remark, submittedBy} ] }
const { route } = require('../../lib/core');
const { query } = require('../../lib/core');
const { parseEntries, resolveSupplierCodes } = require('../../lib/core');
const { RETURN_COLUMNS, pendingCount } = require('../../lib/core');

module.exports = route(['GET', 'POST'], async function (req) {
  if (req.method === 'GET') {
    return await query(`
      SELECT ${RETURN_COLUMNS}
      FROM returns
      WHERE status = 'PENDING'
      ORDER BY id ASC`);
  }

  // POST: insert the whole batch in ONE statement, so it is all-or-nothing.
  const entries = parseEntries(req.body);

  await resolveSupplierCodes(entries);

  const params = [];
  const tuples = entries.map(function (e) {
    const base = params.length;
    params.push(e.supplier, e.supplierCode, e.department, e.brand, e.rpoNo, e.totalItem, e.totalCarton,
      e.rpoDate, e.reason, e.remark, e.submittedBy);
    const p = [];
    for (let i = 1; i <= 11; i++) p.push('$' + (base + i));
    return '(' + p.join(',') + ')';
  });

  const inserted = await query(
    `INSERT INTO returns
       (supplier, supplier_code, department, brand, rpo_no, total_item, total_carton, rpo_date, reason, remark, submitted_by)
     VALUES ${tuples.join(',')}
     RETURNING id::text AS id`,
    params
  );

  return { success: true, added: inserted.length, pendingCount: await pendingCount() };
});
