// GET   /api/transfers?view=outlets                       -> [{code, name}]  (Transfer To type-ahead)
// GET   /api/transfers?status=PENDING|COMPLETED|ALL&q=&from=yyyy-mm-dd&to=yyyy-mm-dd&limit=
// POST  /api/transfers   body { transferTo, outletCode, invoiceNo, department, transferDate, totalCarton, remark }
// PATCH /api/transfers   body { ids:[...], doNo, pickupDate, updatedBy, attachment? }   (bulk complete)
const { route, HttpError, query } = require('../../lib/core');
const { TRANSFER_COLUMNS, parseTransfer, parseBulkTransfers, assertInvoiceFree, resolveOutlet, transferPendingCount } = require('../../lib/core');

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
    const status = String(q.status || 'PENDING').toUpperCase();
    if (['PENDING', 'COMPLETED', 'ALL'].indexOf(status) === -1) throw new HttpError(400, 'Invalid status.');
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
    const order = status === 'COMPLETED' ? 'updated_at DESC NULLS LAST, id DESC' : 'transfer_date ASC, id ASC';
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
    return { success: true, item: rows[0], pendingCount: await transferPendingCount() };
  }

  // PATCH: bulk complete. Only rows that are STILL pending change; others are reported back as skipped.
  const u = parseBulkTransfers(req.body);
  const a = u.attachment || null;
  const done = await query(
    `UPDATE transfers
        SET status = 'COMPLETED', do_no = $1, pickup_date = $2::date, updated_by = $3, updated_at = now(),
            attachment_url = $4, attachment_name = $5, attachment_type = $6
      WHERE id = ANY($7::bigint[]) AND status = 'PENDING'
      RETURNING id::text AS id`,
    [u.doNo, u.pickupDate, u.updatedBy, a && a.url, a && a.name, a && a.type, u.ids]
  );
  const ok = new Set(done.map((r) => r.id));
  return {
    success: true,
    updated: Array.from(ok),
    skipped: u.ids.filter((id) => !ok.has(id)),
    pendingCount: await transferPendingCount(),
  };
});
