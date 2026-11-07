// PUT    /api/transfers/:id  edit a PENDING transfer   body { transferTo, outletCode, invoiceNo, department, transferDate, totalCarton, remark, original }
// PATCH  /api/transfers/:id  body { action: 'complete' | 'correct' | 'undo', doNo, pickupDate, updatedBy, attachment }
//          complete = PENDING -> COMPLETED, correct = change the completion details of a COMPLETED transfer,
//          undo = COMPLETED -> PENDING (completion details cleared)
// DELETE /api/transfers/:id  only while PENDING
// Every change checks the row's current state inside the SQL itself, so two people acting at once cannot both win.
const { route, HttpError, query, parseId } = require('../../lib/core');
const { TRANSFER_COLUMNS, TRANSFER_ORIGINAL_FIELDS, parseTransfer, parseCompletion, parseOriginal, originalSql } = require('../../lib/core');
const { assertInvoiceFree, resolveOutlet, transferPendingCount } = require('../../lib/core');

async function notPending(id) {
  const now = await query('SELECT status FROM transfers WHERE id = $1', [id]);
  return new HttpError(409, now.length
    ? 'This transfer is no longer pending (someone else may have already completed it). Please refresh the list.'
    : 'This transfer no longer exists. Please refresh the list.', 'NOT_PENDING');
}
async function notCompleted(id) {
  const now = await query('SELECT status FROM transfers WHERE id = $1', [id]);
  return new HttpError(409, now.length
    ? 'This transfer is no longer completed (someone else may have changed it). Please refresh the list.'
    : 'This transfer no longer exists. Please refresh the list.', 'NOT_COMPLETED');
}

module.exports = route(['PUT', 'PATCH', 'DELETE'], async function (req) {
  const id = parseId(req.query.id);

  if (req.method === 'PUT') {
    const t = parseTransfer(req.body);
    const original = parseOriginal(req.body, TRANSFER_ORIGINAL_FIELDS);
    const cur = await query('SELECT invoice_no FROM transfers WHERE id = $1', [id]);
    if (cur.length && String(cur[0].invoice_no).trim().toUpperCase() !== t.invoiceNo.trim().toUpperCase()) {
      await assertInvoiceFree(t.invoiceNo, id);
    }
    await resolveOutlet(t);
    const params = [t.transferTo, t.outletCode, t.invoiceNo, t.department, t.transferDate, t.totalCarton, t.remark, id];
    if (original) Array.prototype.push.apply(params, original);
    const rows = await query(
      `UPDATE transfers
          SET transfer_to = $1, outlet_code = $2, invoice_no = $3, department = $4, transfer_date = $5, total_carton = $6, remark = $7
        WHERE id = $8 AND status = 'PENDING'${original ? originalSql(9, TRANSFER_ORIGINAL_FIELDS) : ''}
        RETURNING ${TRANSFER_COLUMNS}`,
      params
    );
    if (!rows.length) {
      const now = await query('SELECT status FROM transfers WHERE id = $1', [id]);
      if (now.length && now[0].status === 'PENDING') {
        throw new HttpError(409, 'Someone else changed this transfer while you were editing it. Their changes are kept; the latest version has been loaded - please re-apply your edit.', 'CHANGED');
      }
      throw await notPending(id);
    }
    return { success: true, item: rows[0], pendingCount: await transferPendingCount() };
  }

  if (req.method === 'PATCH') {
    const action = String((req.body && req.body.action) || '');

    if (action === 'complete') {
      const u = parseCompletion(req.body);
      const a = u.attachment || null;
      const rows = await query(
        `UPDATE transfers
            SET status = 'COMPLETED', do_no = $1, pickup_date = $2::date, updated_by = $3, updated_at = now(),
                attachment_url = $4, attachment_name = $5, attachment_type = $6
          WHERE id = $7 AND status = 'PENDING'
          RETURNING ${TRANSFER_COLUMNS}`,
        [u.doNo, u.pickupDate, u.updatedBy, a && a.url, a && a.name, a && a.type, id]
      );
      if (!rows.length) throw await notPending(id);
      return { success: true, item: rows[0], pendingCount: await transferPendingCount() };
    }

    if (action === 'correct') {
      const u = parseCompletion(req.body);
      const keep = u.attachment === undefined;             // not supplied = leave the attachment as it is
      const a = u.attachment || null;                       // null = remove it
      const rows = await query(
        `UPDATE transfers
            SET do_no = $1, pickup_date = $2::date, updated_by = $3, updated_at = now(),
                attachment_url  = CASE WHEN $4::boolean THEN attachment_url  ELSE $5 END,
                attachment_name = CASE WHEN $4::boolean THEN attachment_name ELSE $6 END,
                attachment_type = CASE WHEN $4::boolean THEN attachment_type ELSE $7 END
          WHERE id = $8 AND status = 'COMPLETED'
          RETURNING ${TRANSFER_COLUMNS}`,
        [u.doNo, u.pickupDate, u.updatedBy, keep, a && a.url, a && a.name, a && a.type, id]
      );
      if (!rows.length) throw await notCompleted(id);
      return { success: true, item: rows[0], pendingCount: await transferPendingCount() };
    }

    if (action === 'undo') {
      const rows = await query(
        `UPDATE transfers
            SET status = 'PENDING', do_no = NULL, pickup_date = NULL, updated_by = NULL, updated_at = NULL,
                attachment_url = NULL, attachment_name = NULL, attachment_type = NULL
          WHERE id = $1 AND status = 'COMPLETED'
          RETURNING ${TRANSFER_COLUMNS}`,
        [id]
      );
      if (!rows.length) throw await notCompleted(id);
      return { success: true, item: rows[0], pendingCount: await transferPendingCount() };
    }

    throw new HttpError(400, 'Unknown action.');
  }

  const rows = await query(`DELETE FROM transfers WHERE id = $1 AND status = 'PENDING' RETURNING id`, [id]);
  if (!rows.length) throw await notPending(id);
  return { success: true, pendingCount: await transferPendingCount() };
});
