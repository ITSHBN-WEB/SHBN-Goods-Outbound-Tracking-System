// GET   /api/suppliers          -> [{ code, name }]  active vendors, for the supplier type-ahead (the page filters in the browser).
//                                  Management also gets ?all=1 -> every supplier with its active flag, for the maintenance screen.
// POST  /api/suppliers          -> Management: { code, name }  add a supplier
// PATCH /api/suppliers          -> Management: { code, name?, active? }  rename / deactivate / reactivate
// Every change is written to the supplier change log (Head Office and Management can read it).
const { route, HttpError, query, audit } = require('../lib/core');

module.exports = route(['GET', 'POST', 'PATCH'], async function (req) {
  if (req.method === 'GET') {
    if (req.query.all && req.user.category === 'MANAGEMENT') return await query(`SELECT code, name, active FROM suppliers ORDER BY name, code`);
    return await query(`SELECT code, name FROM suppliers WHERE active ORDER BY name, code`);
  }
  if (req.user.category !== 'MANAGEMENT') throw new HttpError(403, 'Only Management can change the supplier list.', 'FORBIDDEN');
  const b = req.body || {};
  const code = String(b.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{1,30}$/.test(code)) throw new HttpError(400, 'Supplier code must be letters, numbers or - (max 30).');

  if (req.method === 'POST') {
    const name = String(b.name || '').trim().toUpperCase().slice(0, 200);
    if (!name) throw new HttpError(400, 'Supplier name is required.');
    const rows = await query('INSERT INTO suppliers (code, name) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING code', [code, name]);
    if (!rows.length) throw new HttpError(409, 'Supplier code ' + code + ' already exists.', 'DUPLICATE_SUPPLIER');
    await audit(req, 'SUPPLIER_ADD', 'SUPPLIER', code, name);
    return { success: true };
  }

  const cur = (await query('SELECT code, name, active FROM suppliers WHERE code = $1', [code]))[0];
  if (!cur) throw new HttpError(404, 'Supplier not found.');
  if (b.name !== undefined) {
    const name = String(b.name).trim().toUpperCase().slice(0, 200);
    if (!name) throw new HttpError(400, 'Supplier name is required.');
    if (name !== cur.name) {
      await query('UPDATE suppliers SET name = $1 WHERE code = $2', [name, code]);
      await audit(req, 'SUPPLIER_EDIT', 'SUPPLIER', code, cur.name + '  ->  ' + name);
    }
  }
  if (b.active !== undefined && !!b.active !== cur.active) {
    await query('UPDATE suppliers SET active = $1 WHERE code = $2', [!!b.active, code]);
    await audit(req, b.active ? 'SUPPLIER_ACTIVATE' : 'SUPPLIER_DEACTIVATE', 'SUPPLIER', code, cur.name);
  }
  return { success: true };
}, { writeRoles: ['MANAGEMENT'] });
