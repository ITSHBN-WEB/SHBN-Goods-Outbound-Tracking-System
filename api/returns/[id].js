// PATCH  /api/returns/:id  body { status, pickupDate (yyyy-mm-dd or ""), updatedBy }
// DELETE /api/returns/:id
// Both only act on rows that are still PENDING (checked inside the SQL itself, so two people
// clicking at once cannot both win).
const { route, HttpError } = require('../../lib/http');
const { query } = require('../../lib/db');
const { parseId, parseUpdate } = require('../../lib/validate');
const { pendingCount } = require('../../lib/queries');

module.exports = route(['PATCH', 'DELETE'], async function (req) {
  const id = parseId(req.query.id);

  if (req.method === 'PATCH') {
    const u = parseUpdate(req.body);
    const rows = await query(
      `UPDATE returns
          SET status = $1, pickup_date = $2, updated_by = $3, updated_at = now()
        WHERE id = $4 AND status = 'PENDING'
        RETURNING id`,
      [u.status, u.pickupDate, u.updatedBy, id]
    );
    if (!rows.length) {
      throw new HttpError(409, 'This item is no longer pending (someone else may have already updated it). Please refresh the list.');
    }
    return { success: true, pendingCount: await pendingCount() };
  }

  const rows = await query(`DELETE FROM returns WHERE id = $1 AND status = 'PENDING' RETURNING id`, [id]);
  if (!rows.length) {
    throw new HttpError(409, 'This item is no longer pending and cannot be deleted. Please refresh the list.');
  }
  return { success: true, pendingCount: await pendingCount() };
});
