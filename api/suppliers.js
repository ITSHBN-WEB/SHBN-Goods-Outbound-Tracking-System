// GET /api/suppliers -> [{ code, name }]  (active vendors, for the supplier type-ahead).
// The page loads this once and filters in the browser, so typing never hits the database.
const { route } = require('../lib/core');
const { query } = require('../lib/core');

module.exports = route(['GET'], async function () {
  return await query(`SELECT code, name FROM suppliers WHERE active ORDER BY name, code`);
});
