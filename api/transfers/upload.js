// POST /api/transfers/upload?filename=...&type=image/jpeg   (raw file as the request body)
// Stores the picture / PDF in Vercel Blob and returns { url, name, type, size }; the page then sends that
// url with the transfer update. Needs a connected Blob store: either BLOB_READ_WRITE_TOKEN (older stores) or BLOB_STORE_ID (newer stores, which sign in automatically).
// Vercel limits a request body to 4.5 MB, so the page shrinks photos first and refuses larger files.
const { route, HttpError } = require('../../lib/core');

const MAX_BYTES = 4 * 1024 * 1024 + 400 * 1024;      // just under Vercel's 4.5 MB request limit
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

function sniff(buf) {   // the first bytes must really match the declared type
  const hex = buf.slice(0, 12).toString('hex');
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('89504e47')) return 'image/png';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return '';
}
async function readBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'binary');
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_BYTES) throw new HttpError(413, 'File is too large (max 4 MB).'); chunks.push(c); }
  return Buffer.concat(chunks);
}

module.exports = route(['POST'], async function (req) {
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
    throw new HttpError(503, 'Attachments are not set up yet: add a Blob store to the Vercel project (Storage tab) so BLOB_STORE_ID (or BLOB_READ_WRITE_TOKEN) exists, then redeploy.');
  }
  const type = String((req.query && req.query.type) || '');
  if (!TYPES[type]) throw new HttpError(400, 'Only pictures (JPG, PNG, WEBP) and PDF files are allowed.');
  const buf = await readBody(req);
  if (!buf.length) throw new HttpError(400, 'The file is empty.');
  if (buf.length > MAX_BYTES) throw new HttpError(413, 'File is too large (max 4 MB).');
  if (sniff(buf) !== type) throw new HttpError(400, 'The file content does not match its type.');

  const name = String((req.query && req.query.filename) || 'attachment').replace(/[^\w.\- ]+/g, '_').slice(0, 100) || 'attachment';
  const { put } = require('@vercel/blob');
  const blob = await put('transfers/' + name, buf, { access: 'public', addRandomSuffix: true, contentType: type });
  return { url: blob.url, name, type, size: buf.length };
});
