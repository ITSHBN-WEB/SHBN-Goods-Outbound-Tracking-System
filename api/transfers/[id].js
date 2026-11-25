// PUT    /api/transfers/:id  edit a PENDING transfer (Outlet / Management)
// PATCH  /api/transfers/:id  body.action:
//   complete = PENDING -> COMPLETED                  { doNo, pickupDate, updatedBy, attachments? }
//   copy     = add / change the copy-document date   { copyReturnedDate, copySubmittedBy, attachments? }   (a COMPLETED transfer)
//   correct  = fix DO No / pickup (and the copy-document details when sent)   (a COMPLETED transfer)
//   revert   = COMPLETED -> PENDING, Management only, { reason } required (DO / pickup / copy details cleared)
//   attach / detach = add / remove attachments in any status
// DELETE /api/transfers/:id  while PENDING only (Outlet / Management); its attachment files are deleted too
const { route, HttpError, query, parseId, requireAdmin, scopeOf, assertOwn, audit } = require('../../lib/core');
const { TRANSFER_COLUMNS, TRANSFER_ORIGINAL_FIELDS, MAX_ATTACHMENTS, parseTransfer, parseCompletion, parseCopy, parseAttachments, parseOriginal, originalSql } = require('../../lib/core');
const { assertInvoiceFree, resolveOutlet, transferCounts } = require('../../lib/core');

const WRONG_STATE = {
  PENDING: ['NOT_PENDING', 'This transfer is no longer pending (someone else may have already updated it). Please refresh the list.'],
  COMPLETED: ['NOT_COMPLETED', 'This transfer is no longer completed (someone else may have changed it). Please refresh the list.'],
};
// Called when a guarded UPDATE matched no row: work out why and build the right error.
async function whyNot(id, expected, adding) {
  const now = await query('SELECT status, jsonb_array_length(attachments) AS n FROM transfers WHERE id = $1', [id]);
  if (!now.length) return new HttpError(409, 'This transfer no longer exists. Please refresh the list.', WRONG_STATE[expected] ? WRONG_STATE[expected][0] : 'GONE');
  if (expected && now[0].status !== expected) return new HttpError(409, WRONG_STATE[expected][1], WRONG_STATE[expected][0]);
  if (adding && now[0].n + adding > MAX_ATTACHMENTS) {
    return new HttpError(400, 'A transfer can have up to ' + MAX_ATTACHMENTS + ' attachments (it has ' + now[0].n + '). Remove one first.', 'TOO_MANY_ATTACHMENTS');
  }
  return new HttpError(409, 'This transfer was changed by someone else. Please refresh the list.', 'CHANGED');
}
async function withCounts(item, req) { return Object.assign({ success: true, item }, await transferCounts(scopeOf(req))); }

module.exports = route(['PUT', 'PATCH', 'DELETE'], async function (req) {
  const id = parseId(req.query.id);
  await assertOwn('transfers', id, req);          // an Outlet account can only reach its own records

  if (req.method === 'PUT') {
    const t = parseTransfer(req.body);
    const original = parseOriginal(req.body, TRANSFER_ORIGINAL_FIELDS);
    const cur = await query('SELECT invoice_no, status FROM transfers WHERE id = $1', [id]);
    const expected = 'PENDING';
    if (cur.length && String(cur[0].invoice_no).trim().toUpperCase() !== t.invoiceNo.trim().toUpperCase()) {
      await assertInvoiceFree(t.invoiceNo, id);
    }
    await resolveOutlet(t);
    const params = [t.transferTo, t.outletCode, t.invoiceNo, t.department, t.transferDate, t.totalCarton, t.remark, id];
    if (original) Array.prototype.push.apply(params, original);
    const rows = await query(
      `UPDATE transfers
          SET transfer_to = $1, outlet_code = $2, invoice_no = $3, department = $4, transfer_date = $5, total_carton = $6, remark = $7
        WHERE id = $8 AND status = '${expected}'${original ? originalSql(9, TRANSFER_ORIGINAL_FIELDS) : ''}
        RETURNING ${TRANSFER_COLUMNS}`,
      params
    );
    if (!rows.length) {
      const now = await query('SELECT status FROM transfers WHERE id = $1', [id]);
      if (now.length && now[0].status === expected) {
        throw new HttpError(409, 'Someone else changed this transfer while you were editing it. Their changes are kept; the latest version has been loaded - please re-apply your edit.', 'CHANGED');
      }
      throw await whyNot(id, expected);
    }
    return await withCounts(rows[0], req);
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};
    const action = String(body.action || '');

    if (action === 'complete') {             // PENDING -> COMPLETED
      const u = parseCompletion(body);
      const rows = await query(
        `UPDATE transfers
            SET status = 'COMPLETED', do_no = $1, pickup_date = $2::date, updated_by = $3, updated_at = now(),
                attachments = attachments || $4::jsonb
          WHERE id = $5 AND status = 'PENDING' AND jsonb_array_length(attachments) + $6::int <= ${MAX_ATTACHMENTS}
          RETURNING ${TRANSFER_COLUMNS}`,
        [u.doNo, u.pickupDate, u.updatedBy, JSON.stringify(u.attachments), id, u.attachments.length]
      );
      if (!rows.length) throw await whyNot(id, 'PENDING', u.attachments.length);
      return await withCounts(rows[0], req);
    }

    if (action === 'copy') {                 // additional data on a completed transfer (first entry or a change)
      const u = parseCopy(body);
      const rows = await query(
        `UPDATE transfers
            SET copy_returned_date = $1::date, copy_submitted_by = $2, copy_updated_at = now(),
                attachments = attachments || $3::jsonb
          WHERE id = $4 AND status = 'COMPLETED' AND jsonb_array_length(attachments) + $5::int <= ${MAX_ATTACHMENTS}
          RETURNING ${TRANSFER_COLUMNS}`,
        [u.copyReturnedDate, u.copySubmittedBy, JSON.stringify(u.attachments), id, u.attachments.length]
      );
      if (!rows.length) throw await whyNot(id, 'COMPLETED', u.attachments.length);
      return await withCounts(rows[0], req);
    }

    if (action === 'correct') {
      const u = parseCompletion(body);
      const withCopy = body.copyReturnedDate !== undefined || body.copySubmittedBy !== undefined;   // a COMPLETED transfer also has copy details
      const c = withCopy ? parseCopy(body) : { copyReturnedDate: null, copySubmittedBy: null };
      const expected = 'COMPLETED';
      const rows = await query(
        `UPDATE transfers
            SET do_no = $1, pickup_date = $2::date, updated_by = $3, updated_at = now(),
                copy_returned_date = CASE WHEN $4::boolean THEN $5::date ELSE copy_returned_date END,
                copy_submitted_by  = CASE WHEN $4::boolean THEN $6 ELSE copy_submitted_by END,
                copy_updated_at    = CASE WHEN $4::boolean THEN now() ELSE copy_updated_at END
          WHERE id = $7 AND status = $8
          RETURNING ${TRANSFER_COLUMNS}`,
        [u.doNo, u.pickupDate, u.updatedBy, withCopy, c.copyReturnedDate, c.copySubmittedBy, id, expected]
      );
      if (!rows.length) throw await whyNot(id, expected);
      return await withCounts(rows[0], req);
    }

    if (action === 'revert') {               // Management only: a COMPLETED transfer goes back to Pending, with a reason
      if (req.user.category !== 'MANAGEMENT') throw new HttpError(403, 'Only Management can revert a completed transfer.', 'FORBIDDEN');
      const reason = String(body.reason || '').trim().replace(/\s+/g, ' ');
      if (reason.length < 3) throw new HttpError(400, 'Please enter the reason for reverting this transfer.');
      if (reason.length > 300) throw new HttpError(400, 'The reason is too long (300 characters at most).');
      const rows = await query(
        `UPDATE transfers
            SET status = 'PENDING', do_no = NULL, pickup_date = NULL, updated_by = NULL, updated_at = NULL,
                copy_returned_date = NULL, copy_submitted_by = NULL, copy_updated_at = NULL
          WHERE id = $1 AND status = 'COMPLETED' RETURNING ${TRANSFER_COLUMNS}, origin`, [id]);
      if (!rows.length) throw await whyNot(id, 'COMPLETED');
      await audit(req, 'REVERT', 'TRANSFER', rows[0].invoiceNo, 'Completed -> Pending / Reason: ' + reason, { reason }, rows[0].origin);
      return await withCounts(rows[0], req);
    }

    if (action === 'attach') {
      const list = parseAttachments(body.attachments);
      if (!list.length) throw new HttpError(400, 'Choose at least one file to attach.');
      const rows = await query(
        `UPDATE transfers SET attachments = attachments || $1::jsonb
          WHERE id = $2 AND jsonb_array_length(attachments) + $3::int <= ${MAX_ATTACHMENTS}
          RETURNING ${TRANSFER_COLUMNS}`,
        [JSON.stringify(list), id, list.length]
      );
      if (!rows.length) throw await whyNot(id, null, list.length);
      return await withCounts(rows[0], req);
    }

    if (action === 'detach') {
      requireAdmin(req);
      const url = String(body.url || '');
      if (!url || url.length > 600) throw new HttpError(400, 'Which attachment?');
      const rows = await query(
        `UPDATE transfers
            SET attachments = COALESCE((SELECT jsonb_agg(a) FROM jsonb_array_elements(attachments) AS a WHERE a->>'url' <> $1), '[]'::jsonb)
          WHERE id = $2 RETURNING ${TRANSFER_COLUMNS}`,
        [url, id]
      );
      if (!rows.length) throw await whyNot(id, null);
      return await withCounts(rows[0], req);
    }

    throw new HttpError(400, 'Unknown action.');
  }

  requireAdmin(req);
  // Only a PENDING transfer can be deleted (a completed one must be reverted to Pending first by Management).
  // delete + audit copy in ONE statement, so a deleted record always leaves a trace for Head Office. The audit copy keeps the details only
  // (no attachments); the attachment files themselves are removed from storage right after.
  const rows = await query(
    `WITH d AS (DELETE FROM transfers WHERE id = $1 AND status = 'PENDING' RETURNING *),
          a AS (INSERT INTO audit_log (actor, action, kind, ref, detail, snapshot, origin)
                SELECT $2, 'DELETE', 'TRANSFER', invoice_no, transfer_to || ' / ' || status,
                       (to_jsonb(d) - 'attachments'), origin FROM d RETURNING id)
     SELECT (SELECT attachments FROM d LIMIT 1) AS attachments, (SELECT count(*) FROM a)::int AS n`,
    [id, req.user.loginId]);
  if (!rows.length || !rows[0].n) throw await whyNot(id, 'PENDING');
  const urls = (Array.isArray(rows[0].attachments) ? rows[0].attachments : []).map((x) => x && x.url).filter((u) => typeof u === 'string' && /^https:\/\//.test(u));
  if (urls.length) {
    try { await require('@vercel/blob').del(urls); } catch (e) { console.error('attachment cleanup failed', e && e.message); }
  }
  return Object.assign({ success: true }, await transferCounts(scopeOf(req)));
});
