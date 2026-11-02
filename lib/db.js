// Neon (Postgres) access for the serverless functions.
// DATABASE_URL = your Neon connection string, set in Vercel > Project > Settings > Environment Variables.
const { neon } = require('@neondatabase/serverless');

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

module.exports = { query };
