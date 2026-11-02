// GET  /api/returns  -> list of all PENDING returns (Update Return screen)
// POST /api/returns  -> body { entries: [ {supplier, department, brand, rpoNo, totalItem,
//                        totalCarton, rpoDate (yyyy-mm-dd), reason, remark, submittedBy} ] }
const { route, HttpError } = require('../../lib/core');
const { query } = require('../../lib/core');
const { parseEntries } = require('../../lib/core');
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

  // Entries picked from the vendor list carry a supplier code: check it exists and use the
  // official name. Entries without a code (typed by hand) are saved as typed, code empty.
  const wanted = Array.from(new Set(entries.map((e) => e.supplierCode).filter(Boolean)));
  if (wanted.length) {
    const found = await query(`SELECT code, name FROM suppliers WHERE code = ANY($1::text[])`, [wanted]);
    const byCode = new Map(found.map((r) => [r.code, r.name]));
    entries.forEach(function (e, i) {
      if (!e.supplierCode) return;
      if (!byCode.has(e.supplierCode)) throw new HttpError(400, 'Entry ' + (i + 1) + ': supplier code ' + e.supplierCode + ' is not in the vendor list.');
      e.supplier = byCode.get(e.supplierCode);
    });
  }

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
