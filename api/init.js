// GET /api/init  - dropdown lists + pending count (replaces getInitData)
const { route, scopeOf } = require('../lib/core');
const { DEPARTMENTS, REASONS, UPDATE_STATUSES } = require('../lib/core');
const { pendingCount, query } = require('../lib/core');

module.exports = route(['GET'], async function (req) {
  return {
    departments: DEPARTMENTS,
    reasons: REASONS,
    updateStatuses: UPDATE_STATUSES,
    user: req.user,
    outlets: req.user.category === 'OUTLET' ? [] : (await query("SELECT login_id AS id FROM accounts WHERE category = 'OUTLET' AND active ORDER BY login_id")).map((r) => r.id),
    pendingCount: await pendingCount(scopeOf(req)),
  };
}, { allowMustChange: true });
