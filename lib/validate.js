// Input rules - same as the old form (Supplier, Department, RPO No, Total Item, Reason and
// Submitted By are required), enforced on the server as well.
const { HttpError } = require('./http');

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
      supplier: requiredText(e.supplier, 'Supplier', 120, true),
      department: oneOf(e.department, DEPARTMENTS, 'Department'),
      brand: optionalText(e.brand, 'Brand', 120, true),
      rpoNo: requiredText(e.rpoNo, 'RPO No', 40, true),
      totalItem: wholeNumber(e.totalItem, 'Total Item', 1, true),
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

module.exports = { DEPARTMENTS, REASONS, UPDATE_STATUSES, parseEntries, parseId, parseUpdate };
