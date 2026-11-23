// PUT    /api/returns/:id  body { supplier, supplierCode, department, brand, rpoNo, totalItem,
//                          totalCarton, rpoDate, reason, remark, submittedBy }  (edit a pending return)
// PATCH  /api/returns/:id  body { status, pickupDate (yyyy-mm-dd or ""), updatedBy }
// DELETE /api/returns/:id
// Both only act on rows that are still PENDING (checked inside the SQL itself, so two people
// clicking at once cannot both win).
const { route, HttpError, scopeOf, assertOwn, audit } = require('../../lib/core');
const { query } = require('../../lib/core');
const { parseId, parseUpdate, parseEntry, resolveSupplierCodes, assertRpoFree, parseOriginal, originalSql, RETURN_COLUMNS } = require('../../lib/core');
const { pendingCount } = require('../../lib/core');

module.exports = route(['PUT', 'PATCH', 'DELETE'], async function (req) {
  const id = parseId(req.query.id);
  await assertOwn('returns', id, req);          // an Outlet account can only reach its own records
  const scope = scopeOf(req);

  if (req.method === 'PUT') {
    const e = parseEntry(req.body, 0);
    const original = parseOriginal(req.body);
    // only check for duplicates when the RPO number actually changes (old data may already hold duplicates)
    const cur = await query('SELECT rpo_no FROM returns WHERE id = $1', [id]);
    if (cur.length && String(cur[0].rpo_no).trim().toUpperCase() !== e.rpoNo.trim().toUpperCase()) {
      await assertRpoFree([e.rpoNo], id);
    }
    await resolveSupplierCodes([e]);
    const params = [e.supplier, e.supplierCode, e.department, e.brand, e.rpoNo, e.totalItem, e.totalCarton,
      e.rpoDate, e.reason, e.remark, e.submittedBy, id];
    if (original) Array.prototype.push.apply(params, original);
    const rows = await query(
      `UPDATE returns
          SET supplier = $1, supplier_code = $2, department = $3, brand = $4, rpo_no = $5,
              total_item = $6, total_carton = $7, rpo_date = $8, reason = $9, remark = $10, submitted_by = $11
        WHERE id = $12 AND status = 'PENDING'${original ? originalSql(13) : ''}
        RETURNING ${RETURN_COLUMNS}`,
      params
    );
    if (!rows.length) {
      const now = await query('SELECT status FROM returns WHERE id = $1', [id]);
      if (now.length && now[0].status === 'PENDING') {
        throw new HttpError(409, 'Someone else changed this RPO while you were editing it. Their changes are kept; the latest version has been loaded - please re-apply your edit.', 'CHANGED');
      }
      throw new HttpError(409, 'This item is no longer pending (someone else may have already updated it). Please refresh the list.', 'NOT_PENDING');
    }
    return { success: true, item: rows[0], pendingCount: await pendingCount(scope) };
  }

  if (req.method === 'PATCH' && req.body && req.body.action === 'revert') {      // Management only: a completed return goes back to Pending
    if (req.user.category !== 'MANAGEMENT') throw new HttpError(403, 'Only Management can revert a completed return.', 'FORBIDDEN');
    const rows = await query(
      `UPDATE returns SET status = 'PENDING', pickup_date = NULL, updated_by = NULL, updated_at = NULL
        WHERE id = $1 AND status <> 'PENDING' RETURNING rpo_no, supplier, origin`, [id]);
    if (!rows.length) throw new HttpError(409, 'This item is already pending. Please refresh the list.');
    await audit(req, 'REVERT', 'RETURN', rows[0].rpo_no, rows[0].supplier + ' / back to Pending', null, rows[0].origin);
    return { success: true, pendingCount: await pendingCount(scope) };
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
    return { success: true, pendingCount: await pendingCount(scope) };
  }

  const rows = await query(
    `WITH d AS (DELETE FROM returns WHERE id = $1 AND status = 'PENDING' RETURNING *)
     INSERT INTO audit_log (actor, action, kind, ref, detail, snapshot, origin)
     SELECT $2, 'DELETE', 'RETURN', rpo_no, supplier || ' / ' || status, to_jsonb(d), origin FROM d RETURNING id`,
    [id, req.user.loginId]);
  if (!rows.length) {
    throw new HttpError(409, 'This item is no longer pending and cannot be deleted. Please refresh the list.');
  }
  return { success: true, pendingCount: await pendingCount(scope) };
});
