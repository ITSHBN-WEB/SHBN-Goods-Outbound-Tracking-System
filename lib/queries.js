// SQL shared by several endpoints. Dates leave the database as plain text, so the JSON never
// contains Date objects: rpoDate is "2026-07-09", dateSubmitted is "10.7.2026 3.23PM"
// (the same display format as the old sheet, in Kuala Lumpur time).
const { query } = require('./db');

const RETURN_COLUMNS = `
  id::text AS id,
  supplier,
  department,
  brand,
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

module.exports = { RETURN_COLUMNS, pendingCount };
