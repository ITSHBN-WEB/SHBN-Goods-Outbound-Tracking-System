// GET /api/init  - dropdown lists + pending count (replaces getInitData)
const { route } = require('../lib/core');
const { DEPARTMENTS, REASONS, UPDATE_STATUSES } = require('../lib/core');
const { pendingCount } = require('../lib/core');

module.exports = route(['GET'], async function () {
  return {
    departments: DEPARTMENTS,
    reasons: REASONS,
    updateStatuses: UPDATE_STATUSES,
    pinRequired: !!process.env.APP_PIN,
    pendingCount: await pendingCount(),
  };
});
