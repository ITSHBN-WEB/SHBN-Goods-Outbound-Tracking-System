// GET   /api/transfers?view=outlets                       -> [{code, name}]  (Transfer To type-ahead)
// GET   /api/transfers?view=dashboard                     -> { pendingCount, awaitingCount, recent:[latest 6 transfers] }
// GET   /api/transfers?status=PENDING|AWAITING_COPY|COMPLETED|ALL&q=&from=yyyy-mm-dd&to=yyyy-mm-dd&limit=
// POST  /api/transfers   body { transferTo, outletCode, invoiceNo, department, transferDate, totalCarton, remark }
// PATCH /api/transfers   bulk update, body { ids:[...], ... }
//         step 1 (default / action:'complete'): { doNo, pickupDate, updatedBy, attachments? }   PENDING -> AWAITING_COPY
//         step 2 (action:'copy'):               { copyReturnedDate, copySubmittedBy, attachments? }   AWAITING_COPY -> COMPLETED
const { route, HttpError, query } = require('../../lib/core');
const { TRANSFER_COLUMNS, parseTransfer, parseBulkTransfers, MAX_ATTACHMENTS, assertInvoiceFree, resolveOutlet, transferCounts } = require('../../lib/core');

function dateParam(v, label) {
  if (v === undefined || v === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new HttpError(400, label + ' is not a valid date.');
  return String(v);
}

module.exports = route(['GET', 'POST', 'PATCH'], async function (req) {
  if (req.method === 'GET') {
    const q = req.query || {};
    if (q.view === 'outlets') {
      return await query('SELECT code, name FROM outlets WHERE active ORDER BY name, code');
    }
    if (q.view === 'dashboard') {         // dashboard card: pending count + the 6 most recently submitted / completed transfers
      const [counts, recent] = await Promise.all([
        transferCounts(),
        query(`SELECT ${TRANSFER_COLUMNS} FROM transfers
                ORDER BY GREATEST(created_at, COALESCE(updated_at, created_at), COALESCE(copy_updated_at, created_at)) DESC, id DESC LIMIT 6`)
      ]);
      return Object.assign({ recent }, counts);
    }
    const status = String(q.status || 'PENDING').toUpperCase();
    if (['PENDING', 'AWAITING_COPY', 'COMPLETED', 'ALL'].indexOf(status) === -1) throw new HttpError(400, 'Invalid status.');
    const from = dateParam(q.from, 'From date'), to = dateParam(q.to, 'To date');
    const where = [], params = [];
    if (status !== 'ALL') { params.push(status); where.push('status = $' + params.length); }
    if (from) { params.push(from); where.push('transfer_date >= $' + params.length + '::date'); }
    if (to) { params.push(to); where.push('transfer_date <= $' + params.length + '::date'); }
    const needle = String(q.q || '').trim().slice(0, 80);
    if (needle) {
      params.push('%' + needle.replace(/[\\%_]/g, '\\$&') + '%');
      const n = '$' + params.length;
      where.push(`(invoice_no ILIKE ${n} OR transfer_to ILIKE ${n} OR COALESCE(do_no,'') ILIKE ${n} OR department ILIKE ${n})`);
    }
    const cap = status === 'COMPLETED' && !from && !to ? 200 : 5000;
    const limit = Math.min(parseInt(q.limit, 10) || cap, 5000);
    const order = status === 'COMPLETED' ? 'COALESCE(copy_updated_at, updated_at) DESC NULLS LAST, id DESC'
      : status === 'AWAITING_COPY' ? 'updated_at ASC NULLS LAST, id ASC'          // longest-waiting copy-document first
      : 'transfer_date ASC, id ASC';
    return await query(
      `SELECT ${TRANSFER_COLUMNS} FROM transfers ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ${limit}`,
      params
    );
  }

  if (req.method === 'POST') {
    const t = parseTransfer(req.body);
    await assertInvoiceFree(t.invoiceNo);
    await resolveOutlet(t);
    const rows = await query(
      `INSERT INTO transfers (transfer_to, outlet_code, invoice_no, department, transfer_date, total_carton, remark)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${TRANSFER_COLUMNS}`,
      [t.transferTo, t.outletCode, t.invoiceNo, t.department, t.transferDate, t.totalCarton, t.remark]
    );
    return Object.assign({ success: true, item: rows[0] }, await transferCounts());
  }

  // PATCH: bulk update. Only rows that are STILL in the expected status change; others are reported back as skipped.
  const copyStep = String((req.body && req.body.action) || '') === 'copy';
  const u = parseBulkTransfers(req.body, copyStep ? 'copy' : 'complete');
  const att = JSON.stringify(u.attachments), n = u.attachments.length;
  const done = copyStep
    ? await query(
        `UPDATE transfers
            SET status = 'COMPLETED', copy_returned_date = $1::date, copy_submitted_by = $2, copy_updated_at = now(),
                attachments = attachments || $3::jsonb
          WHERE id = ANY($4::bigint[]) AND status = 'AWAITING_COPY' AND jsonb_array_length(attachments) + $5::int <= ${MAX_ATTACHMENTS}
          RETURNING id::text AS id`,
        [u.copyReturnedDate, u.copySubmittedBy, att, u.ids, n])
    : await query(
        `UPDATE transfers
            SET status = 'AWAITING_COPY', do_no = $1, pickup_date = $2::date, updated_by = $3, updated_at = now(),
                attachments = attachments || $4::jsonb
          WHERE id = ANY($5::bigint[]) AND status = 'PENDING' AND jsonb_array_length(attachments) + $6::int <= ${MAX_ATTACHMENTS}
          RETURNING id::text AS id`,
        [u.doNo, u.pickupDate, u.updatedBy, att, u.ids, n]);
  const ok = new Set(done.map((r) => r.id));
  return Object.assign({
    success: true,
    updated: Array.from(ok),
    skipped: u.ids.filter((id) => !ok.has(id)),
  }, await transferCounts());
});
