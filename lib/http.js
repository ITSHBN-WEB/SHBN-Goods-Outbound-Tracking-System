// Shared request plumbing: CORS, optional PIN, method check, error handling.
const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
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
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      console.error(err);
      return res.status(500).json({ error: 'Server error. Please try again.' });
    }
  };
}

module.exports = { route, HttpError };
