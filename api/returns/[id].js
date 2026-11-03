// PUT    /api/returns/:id  body { supplier, supplierCode, department, brand, rpoNo, totalItem,
//                          totalCarton, rpoDate, reason, remark, submittedBy }  (edit a pending return)
// PATCH  /api/returns/:id  body { status, pickupDate (yyyy-mm-dd or ""), updatedBy }
// DELETE /api/returns/:id
// Both only act on rows that are still PENDING (checked inside the SQL itself, so two people
// clicking at once cannot both win).
const { route, HttpError } = require('../../lib/core');
const { query } = require('../../lib/core');
const { parseId, parseUpdate, parseEntry, resolveSupplierCodes, RETURN_COLUMNS } = require('../../lib/core');
const { pendingCount } = require('../../lib/core');

module.exports = route(['PUT', 'PATCH', 'DELETE'], async function (req) {
  const id = parseId(req.query.id);

  if (req.method === 'PUT') {
    const e = parseEntry(req.body, 0);
    await resolveSupplierCodes([e]);
    const rows = await query(
      `UPDATE returns
          SET supplier = $1, supplier_code = $2, department = $3, brand = $4, rpo_no = $5,
              total_item = $6, total_carton = $7, rpo_date = $8, reason = $9, remark = $10, submitted_by = $11
        WHERE id = $12 AND status = 'PENDING'
        RETURNING ${RETURN_COLUMNS}`,
      [e.supplier, e.supplierCode, e.department, e.brand, e.rpoNo, e.totalItem, e.totalCarton,
        e.rpoDate, e.reason, e.remark, e.submittedBy, id]
    );
    if (!rows.length) {
      throw new HttpError(409, 'This item is no longer pending (someone else may have already updated it). Please refresh the list.');
    }
    return { success: true, item: rows[0], pendingCount: await pendingCount() };
  }

  if (req.method === 'PATCH') {
    const u = parseUpdate(req.body);
    const rows = await query(
      `UPDATE returns
          SET status = $1, pickup_date = $2, updated_by = $3, updated_at = now()
        WHERE id = $4 AND status = 'PENDING'
        RETURNING id`,
      [u.status, u.pickupDate, u.updatedBy, id]
    );
    if (!rows.length) {
      throw new HttpError(409, 'This item is no longer pending (someone else may have already updated it). Please refresh the list.');
    }
    return { success: true, pendingCount: await pendingCount() };
  }

  const rows = await query(`DELETE FROM returns WHERE id = $1 AND status = 'PENDING' RETURNING id`, [id]);
  if (!rows.length) {
    throw new HttpError(409, 'This item is no longer pending and cannot be deleted. Please refresh the list.');
  }
  return { success: true, pendingCount: await pendingCount() };
});
