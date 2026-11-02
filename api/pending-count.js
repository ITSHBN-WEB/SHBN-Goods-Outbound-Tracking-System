// GET /api/pending-count  -> { pendingCount, overdueCount }
// Same shape as the old Apps Script "?api=pending", so the Control Tower card only needs a URL swap.
// Open to any origin and needs no PIN (it only exposes two numbers).
// Overdue = RPO date more than 30 days ago (Kuala Lumpur date), same rule as before.
const { route } = require('../lib/http');
const { query } = require('../lib/db');

module.exports = route(['GET'], async function () {
  const rows = await query(`
    SELECT
      count(*)::int AS "pendingCount",
      count(*) FILTER (
        WHERE rpo_date IS NOT NULL
          AND ((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date - rpo_date) > 30
      )::int AS "overdueCount"
    FROM returns
    WHERE status = 'PENDING'`);
  return rows[0];
}, { anyOrigin: true });
