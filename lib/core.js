// All shared server code in ONE file (Vercel free plan: keep the repo small).
// Sections: database, http (CORS/PIN/errors), validation, shared queries.
const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

// ============================ DATABASE ============================
// Neon (Postgres) access for the serverless functions.
// DATABASE_URL = your Neon connection string, set in Vercel > Project > Settings > Environment Variables.

let sql = null;

function getSql() {
  if (!sql) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    sql = neon(process.env.DATABASE_URL);
  }
  return sql;
}

// Returns an array of row objects.
function query(text, params) {
  return getSql().query(text, params || []);
}

// ============================ HTTP ============================
// Shared request plumbing: CORS, optional PIN, method check, error handling.

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || undefined;   // machine-readable reason, e.g. 'CHANGED', 'DUPLICATE_RPO'
  }
}

// The GitHub Pages site is allowed by default. Add more (comma-separated) in the
// ALLOWED_ORIGINS environment variable, e.g. a custom domain or http://localhost:3000 for testing.
function allowedOrigins() {
  const extra = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return ['https://itshbn-web.github.io'].concat(extra);
}

function pinMatches(given) {
  const expected = Buffer.from(String(process.env.APP_PIN || ''));
  const got = Buffer.from(String(given || ''));
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

/**
 * Wraps a handler.
 *   methods:     allowed HTTP methods, e.g. ['GET', 'POST']
 *   opts.anyOrigin: true for the read-only counts endpoint (the Control Tower dashboard calls it
 *                   cross-origin, as it did with the old Apps Script ?api=pending). No PIN either.
 * The handler receives (req) and returns a plain object (sent as JSON, 200) or { status, body }.
 */
function route(methods, handler, opts) {
  const o = opts || {};
  return async function (req, res) {
    const origin = req.headers.origin;
    // Same-site requests (page and API both served by Vercel) always count as allowed.
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const originOk = !origin || allowedOrigins().includes(origin) || (!!host && origin === 'https://' + host);

    if (o.anyOrigin) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && originOk) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Pin');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') return res.status(204).end();

    try {
      if (methods.indexOf(req.method) === -1) {
        res.setHeader('Allow', methods.join(', '));
        throw new HttpError(405, 'Method not allowed');
      }
      // CORS only stops other sites from READING responses; refuse their writes outright too.
      if (!o.anyOrigin && !originOk) throw new HttpError(403, 'Origin not allowed');
      if (!o.anyOrigin && process.env.APP_PIN && !pinMatches(req.headers['x-app-pin'])) {
        throw new HttpError(401, 'PIN_REQUIRED');
      }

      const out = await handler(req);
      return res.status(200).json(out);
    } catch (err) {
      if (err instanceof HttpError) {
        return res.status(err.status).json(err.code ? { error: err.message, code: err.code } : { error: err.message });
      }
      // Unique index (see unique-rpo.sql) caught a duplicate RPO that slipped past the pre-check (two saves at once)
      if (err && err.code === '23505') {
        const isTransfer = /transfers/.test(String(err.constraint || err.message || ''));
        return res.status(409).json(isTransfer
          ? { error: 'This Invoice / ODO No already exists. Duplicates are not allowed.', code: 'DUPLICATE_INVOICE' }
          : { error: 'This RPO number already exists. Duplicate RPOs are not allowed.', code: 'DUPLICATE_RPO' });
      }
      console.error(err);
      return res.status(500).json({ error: 'Server error. Please try again.' });
    }
  };
}

// ============================ VALIDATION ============================
// Input rules - same as the old form (Supplier, Department, RPO No, Total Item, Reason and
// Submitted By are required), enforced on the server as well.

const DEPARTMENTS = ['FOOD', 'NONFOOD', 'FRESH MARKET'];
const REASONS = ['DAMAGED', 'EXPIRED', 'OTHERS'];
const UPDATE_STATUSES = ['RETURNED', 'DISPOSED', 'OTHERS'];
const MAX_BATCH = 200;

function text(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function bad(msg) {
  return new HttpError(400, msg);
}

function requiredText(v, label, max, upper) {
  let s = text(v);
  if (upper) s = s.toUpperCase();
  if (!s) throw bad(label + ' is required.');
  if (s.length > max) throw bad(label + ' is too long (max ' + max + ').');
  return s;
}

function optionalText(v, label, max, upper) {
  let s = text(v);
  if (upper) s = s.toUpperCase();
  if (s.length > max) throw bad(label + ' is too long (max ' + max + ').');
  return s;
}

function wholeNumber(v, label, min, required) {
  const s = text(v);
  if (!s) {
    if (required) throw bad(label + ' is required.');
    return null;
  }
  if (!/^\d{1,7}$/.test(s)) throw bad(label + ' must be a whole number.');
  const n = parseInt(s, 10);
  if (n < min) throw bad(label + ' must be at least ' + min + '.');
  return n;
}

// "2026-07-09" (what <input type="date"> gives) -> same string; blank -> null
function isoDate(v, label) {
  const s = text(v);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw bad(label + ' is not a valid date.');
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    throw bad(label + ' is not a valid date.');
  }
  return s;
}

function supplierCode(v) {
  const s = text(v).toUpperCase();
  if (!s) return null;
  if (!/^[A-Z0-9-]{1,30}$/.test(s)) throw bad('Supplier code is not valid.');
  return s;
}

function oneOf(v, list, label) {
  const s = text(v).toUpperCase();
  if (!s) throw bad(label + ' is required.');
  if (list.indexOf(s) === -1) throw bad(label + ' must be one of: ' + list.join(', ') + '.');
  return s;
}

function parseEntry(e, index) {
  if (!e || typeof e !== 'object') throw bad('Entry ' + (index + 1) + ' is not valid.');
  try {
    return {
      supplier: requiredText(e.supplier, 'Supplier', 200, true),
      // set when the user picked the supplier from the vendor list; the server then
      // replaces `supplier` with the official name for that code
      supplierCode: supplierCode(e.supplierCode),
      department: oneOf(e.department, DEPARTMENTS, 'Department'),
      brand: optionalText(e.brand, 'Brand', 120, true),
      rpoNo: requiredText(e.rpoNo, 'RPO No', 40, true),
      totalItem: wholeNumber(e.totalItem, 'Total Item', 1, false),   // optional
      totalCarton: wholeNumber(e.totalCarton, 'Total Carton', 0, false),
      rpoDate: isoDate(e.rpoDate, 'RPO Date'),
      reason: oneOf(e.reason, REASONS, 'Reason'),
      remark: optionalText(e.remark, 'Remark', 500, false),
      submittedBy: requiredText(e.submittedBy, 'Submitted By', 60, true),
    };
  } catch (err) {
    if (err instanceof HttpError) throw bad('Entry ' + (index + 1) + ': ' + err.message);
    throw err;
  }
}

function parseEntries(body) {
  const list = body && body.entries;
  if (!Array.isArray(list) || !list.length) throw bad('No entries to submit.');
  if (list.length > MAX_BATCH) throw bad('Too many entries in one submit (max ' + MAX_BATCH + ').');
  return list.map(parseEntry);
}

// Bulk status update: { items: [ {id, status} ], pickupDate, updatedBy }
const MAX_BULK = 200;
function parseBulkUpdate(body) {
  const b = body || {};
  const list = b.items;
  if (!Array.isArray(list) || !list.length) throw bad('No returns selected.');
  if (list.length > MAX_BULK) throw bad('Too many returns in one update (max ' + MAX_BULK + ').');
  const byId = new Map();
  list.forEach(function (it, i) {
    if (!it || typeof it !== 'object') throw bad('Item ' + (i + 1) + ' is not valid.');
    const id = parseId(it.id);
    let status;
    try { status = oneOf(it.status, UPDATE_STATUSES, 'Status'); }
    catch (err) { throw bad('Item ' + (i + 1) + ': ' + err.message); }
    byId.set(id, status);
  });
  return {
    items: Array.from(byId, function (kv) { return { id: kv[0], status: kv[1] }; }),
    pickupDate: isoDate(b.pickupDate, 'Pickup Date'),
    updatedBy: requiredText(b.updatedBy, 'Updated By', 60, true),
  };
}

function parseId(v) {
  const s = text(v);
  if (!/^\d{1,18}$/.test(s)) throw bad('Invalid id.');
  return s;
}

function parseUpdate(body) {
  const b = body || {};
  return {
    status: oneOf(b.status, UPDATE_STATUSES, 'Status'),
    pickupDate: isoDate(b.pickupDate, 'Pickup Date'),
    updatedBy: requiredText(b.updatedBy, 'Updated By', 60, true),
  };
}

// ============================ SHARED QUERIES ============================
// SQL shared by several endpoints. Dates leave the database as plain text, so the JSON never
// contains Date objects: rpoDate is "2026-07-09", dateSubmitted is "10.7.2026 3.23PM"
// (the same display format as the old sheet, in Kuala Lumpur time).

const RETURN_COLUMNS = `
  id::text AS id,
  supplier,
  department,
  brand,
  supplier_code AS "supplierCode",
  rpo_no AS "rpoNo",
  total_item AS "totalItem",
  total_carton AS "totalCarton",
  rpo_date::text AS "rpoDate",
  COALESCE(to_char(rpo_date, 'FMDD.FMMM.YYYY'), '') AS "rpoDateDisplay",
  reason,
  submitted_by AS "submittedBy",
  to_char(submitted_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'FMDD.FMMM.YYYY FMHH12.MIPM') AS "dateSubmitted",
  remark,
  status`;

async function pendingCount() {
  const rows = await query(`SELECT count(*)::int AS n FROM returns WHERE status = 'PENDING'`);
  return rows[0].n;
}

// Entries picked from the vendor list carry a supplier code: check it exists and use the
// official name. Entries without a code (typed by hand) are kept as typed, code empty.
// ---- duplicate RPO guard -------------------------------------------------------
// An RPO number may exist only once (any supplier, any status). Compared trimmed and case-insensitive.
// `excludeId` lets an edit keep its own number.
async function assertRpoFree(rpoNos, excludeId) {
  const keys = rpoNos.map((r) => String(r).trim().toUpperCase());
  const seen = new Set();
  keys.forEach(function (k, i) {
    if (seen.has(k)) throw new HttpError(400, 'RPO ' + rpoNos[i] + ' appears more than once in this submission.', 'DUPLICATE_RPO');
    seen.add(k);
  });
  const rows = await query(
    `SELECT rpo_no, supplier, status FROM returns
      WHERE upper(btrim(rpo_no)) = ANY($1::text[]) AND ($2::bigint IS NULL OR id <> $2::bigint)
      ORDER BY id LIMIT 6`,
    [keys, excludeId === undefined ? null : excludeId]
  );
  if (rows.length) {
    const list = rows.slice(0, 5).map((r) => r.rpo_no + ' (' + (r.supplier || 'no supplier') + ', ' + r.status + ')').join('; ');
    throw new HttpError(409,
      (rows.length === 1 ? 'This RPO already exists: ' : 'These RPOs already exist: ') + list +
      (rows.length > 5 ? '; ...' : '') + '. Duplicate RPOs are not allowed.', 'DUPLICATE_RPO');
  }
}

// ---- edit conflict guard -------------------------------------------------------
// The edit form sends the values it was opened with (`original`). The UPDATE only applies if the row
// STILL holds exactly those values, so one person's save can never silently overwrite another's.
const ORIGINAL_FIELDS = [
  ['supplier', 'supplier'], ['department', 'department'], ['brand', 'brand'], ['rpoNo', 'rpo_no'],
  ['totalItem', 'total_item'], ['totalCarton', 'total_carton'], ['rpoDate', 'rpo_date'],
  ['reason', 'reason'], ['remark', 'remark'], ['submittedBy', 'submitted_by'],
];
function parseOriginal(body, fields) {
  const fl = fields || ORIGINAL_FIELDS;
  const o = body && body.original;
  if (o === undefined || o === null) return null;       // older page without the guard: skip the check
  if (typeof o !== 'object') throw bad('Invalid original values.');
  return fl.map(function (f) { return String(o[f[0]] === null || o[f[0]] === undefined ? '' : o[f[0]]); });
}
function originalSql(startIndex, fields) {   // -> ' AND COALESCE(col::text,'') = $n ...' for each field
  return (fields || ORIGINAL_FIELDS).map(function (f, i) { return ` AND COALESCE(${f[1]}::text,'') = $${startIndex + i}`; }).join('');
}

// ============================ GOODS TRANSFER RECORD ============================
const TRANSFER_STATUSES = ['PENDING', 'COMPLETED'];
const TRANSFER_ORIGINAL_FIELDS = [
  ['transferTo', 'transfer_to'], ['invoiceNo', 'invoice_no'], ['department', 'department'],
  ['transferDate', 'transfer_date'], ['totalCarton', 'total_carton'], ['remark', 'remark'],
];
const TRANSFER_COLUMNS = `
  id::text AS id, transfer_to AS "transferTo", outlet_code AS "outletCode", invoice_no AS "invoiceNo",
  department, transfer_date::text AS "transferDate", total_carton AS "totalCarton", remark, status,
  do_no AS "doNo", pickup_date::text AS "pickupDate", updated_by AS "updatedBy",
  to_char(updated_at AT TIME ZONE 'Asia/Kuala_Lumpur','FMDD.FMMM.YYYY FMHH12.MIPM') AS "dateUpdated",
  attachment_url AS "attachmentUrl", attachment_name AS "attachmentName", attachment_type AS "attachmentType",
  to_char(created_at AT TIME ZONE 'Asia/Kuala_Lumpur','FMDD.FMMM.YYYY FMHH12.MIPM') AS "dateSubmitted"`;
const ATTACHMENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

function parseTransfer(body) {
  const e = body || {};
  if (typeof e !== 'object') throw bad('Invalid entry.');
  const code = text(e.outletCode);
  if (code && !/^[A-Za-z0-9._-]{1,20}$/.test(code)) throw bad('Invalid outlet code.');
  const totalCarton = wholeNumber(e.totalCarton, 'Total Carton', 1, true);
  if (totalCarton > 9999) throw bad('Total Carton is too large (max 9999).');
  const transferDate = isoDate(e.transferDate, 'Date');
  if (!transferDate) throw bad('Date is required.');
  return {
    transferTo: requiredText(e.transferTo, 'Transfer To', 200, true),
    outletCode: code || null,
    invoiceNo: requiredText(e.invoiceNo, 'Invoice / ODO No', 40, true),
    department: requiredText(e.department, 'Department', 60, true),
    transferDate,
    totalCarton,
    remark: optionalText(e.remark, 'Remark', 500, false),
  };
}

// attachment: undefined = not supplied, null = remove, object = {url,name,type} uploaded through /api/transfers/upload
function parseAttachment(a) {
  if (a === undefined) return undefined;
  if (a === null) return null;
  if (typeof a !== 'object') throw bad('Invalid attachment.');
  let u;
  try { u = new URL(String(a.url)); } catch (e) { throw bad('Invalid attachment link.'); }
  if (u.protocol !== 'https:' || !/\.blob\.vercel-storage\.com$/.test(u.hostname)) throw bad('Attachment must be uploaded through the app.');
  const type = text(a.type);
  if (ATTACHMENT_TYPES.indexOf(type) === -1) throw bad('Attachment must be a picture (JPG, PNG, WEBP) or a PDF.');
  return { url: u.toString(), name: requiredText(a.name || 'attachment', 'Attachment name', 150, false), type };
}

function parseCompletion(body) {
  const b = body || {};
  const pickupDate = isoDate(b.pickupDate, 'Pickup Date');
  if (!pickupDate) throw bad('Pickup Date is required.');
  return {
    doNo: requiredText(b.doNo, 'DO No', 60, true),
    pickupDate,
    updatedBy: requiredText(b.updatedBy, 'Updated By', 60, true),
    attachment: parseAttachment(b.attachment),
  };
}

function parseBulkTransfers(body) {
  const b = body || {};
  if (!Array.isArray(b.ids) || !b.ids.length) throw bad('Select at least one invoice.');
  if (b.ids.length > MAX_BULK) throw bad('Please select ' + MAX_BULK + ' invoices or fewer at a time.');
  const ids = Array.from(new Set(b.ids.map(parseId)));
  return Object.assign({ ids }, parseCompletion(b));
}

async function assertInvoiceFree(invoiceNo, excludeId) {
  const rows = await query(
    `SELECT invoice_no, transfer_to, status FROM transfers
      WHERE upper(btrim(invoice_no)) = $1 AND ($2::bigint IS NULL OR id <> $2::bigint) LIMIT 1`,
    [String(invoiceNo).trim().toUpperCase(), excludeId === undefined ? null : excludeId]
  );
  if (rows.length) {
    throw new HttpError(409, 'Invoice / ODO No ' + rows[0].invoice_no + ' already exists (' + rows[0].transfer_to + ', ' + rows[0].status +
      '). Duplicates are not allowed.', 'DUPLICATE_INVOICE');
  }
}

async function resolveOutlet(t) {
  if (!t.outletCode) return;
  const rows = await query('SELECT name FROM outlets WHERE code = $1', [t.outletCode]);
  if (rows.length) t.transferTo = String(rows[0].name).toUpperCase();
  else t.outletCode = null;           // unknown code: keep the typed name, no code
}

async function transferPendingCount() {
  const rows = await query("SELECT count(*)::int AS n FROM transfers WHERE status = 'PENDING'");
  return rows[0].n;
}

async function resolveSupplierCodes(entries) {
  const wanted = Array.from(new Set(entries.map((e) => e.supplierCode).filter(Boolean)));
  if (!wanted.length) return;
  const found = await query(`SELECT code, name FROM suppliers WHERE code = ANY($1::text[])`, [wanted]);
  const byCode = new Map(found.map((r) => [r.code, r.name]));
  entries.forEach(function (e, i) {
    if (!e.supplierCode) return;
    if (!byCode.has(e.supplierCode)) {
      throw new HttpError(400, (entries.length > 1 ? 'Entry ' + (i + 1) + ': ' : '') + 'supplier code ' + e.supplierCode + ' is not in the vendor list.');
    }
    e.supplier = byCode.get(e.supplierCode);
  });
}

module.exports = {
  query, route, HttpError, parseEntry, resolveSupplierCodes, assertRpoFree, parseOriginal, originalSql,
  TRANSFER_STATUSES, TRANSFER_ORIGINAL_FIELDS, TRANSFER_COLUMNS, parseTransfer, parseCompletion, parseBulkTransfers, parseAttachment,
  assertInvoiceFree, resolveOutlet, transferPendingCount,
  DEPARTMENTS, REASONS, UPDATE_STATUSES, parseEntries, parseId, parseUpdate, parseBulkUpdate,
  RETURN_COLUMNS, pendingCount,
};
