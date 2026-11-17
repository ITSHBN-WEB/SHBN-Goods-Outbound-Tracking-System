// GET  /api/returns  -> list of all PENDING returns (Update Return screen)
// PATCH /api/returns -> bulk status update: body { items: [{id, status}], pickupDate, updatedBy }
// POST /api/returns  -> body { entries: [ {supplier, department, brand, rpoNo, totalItem,
//                        totalCarton, rpoDate (yyyy-mm-dd), reason, remark, submittedBy} ] }
const { route } = require('../../lib/core');
const { query } = require('../../lib/core');
const { parseEntries, parseBulkUpdate, resolveSupplierCodes, assertRpoFree } = require('../../lib/core');
const { RETURN_COLUMNS, pendingCount } = require('../../lib/core');

module.exports = route(['GET', 'POST', 'PATCH'], async function (req) {
  if (req.method === 'GET') {
    // ?status=done  -> every return that has been picked up / disposed / otherwise completed (newest update first)
    if (req.query.status === 'done') {
      const params = [];
      let where = "status <> 'PENDING'";
      const needle = String(req.query.q || '').trim().slice(0, 80);
      if (needle) {
        params.push('%' + needle.replace(/[\\%_]/g, '\\$&') + '%');
        where += ' AND (rpo_no ILIKE $1 OR supplier ILIKE $1 OR brand ILIKE $1 OR COALESCE(updated_by, \'\') ILIKE $1)';
      }
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
      return await query(`
        SELECT ${RETURN_COLUMNS},
               pickup_date::text AS "pickupDate",
               COALESCE(to_char(pickup_date, 'FMDD.FMMM.YYYY'), '') AS "pickupDateDisplay",
               updated_by AS "updatedBy",
               to_char(updated_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'FMDD.FMMM.YYYY FMHH12.MIPM') AS "dateUpdated"
          FROM returns
         WHERE ${where}
         ORDER BY updated_at DESC NULLS LAST, id DESC
         LIMIT ${limit}`, params);
    }
    return await query(`
      SELECT ${RETURN_COLUMNS}
      FROM returns
      WHERE status = 'PENDING'
      ORDER BY submitted_at DESC NULLS LAST, id DESC`);      // newest entry first
  }

  if (req.method === 'PATCH') {
    // One statement for the whole selection. Only rows that are STILL pending are changed;
    // anything someone else already updated/deleted is reported back as skipped.
    const u = parseBulkUpdate(req.body);
    const params = [u.pickupDate, u.updatedBy];
    const values = u.items.map(function (it) {
      params.push(it.id, it.status);
      return '($' + (params.length - 1) + '::bigint, $' + params.length + '::text)';
    });
    const done = await query(
      `UPDATE returns r
          SET status = v.status, pickup_date = $1::date, updated_by = $2, updated_at = now()
         FROM (VALUES ${values.join(',')}) AS v(id, status)
        WHERE r.id = v.id AND r.status = 'PENDING'
        RETURNING r.id::text AS id`,
      params
    );
    const ok = new Set(done.map((r) => r.id));
    return {
      success: true,
      updated: Array.from(ok),
      skipped: u.items.map((it) => it.id).filter((id) => !ok.has(id)),
      pendingCount: await pendingCount(),
    };
  }

  // POST: insert the whole batch in ONE statement, so it is all-or-nothing.
  const entries = parseEntries(req.body);

  await assertRpoFree(entries.map((e) => e.rpoNo));
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
