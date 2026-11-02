-- SHBN Supplier Return Log - Neon (Postgres) schema
-- Run once in the Neon SQL editor (or: psql "$DATABASE_URL" -f schema.sql)

CREATE TABLE IF NOT EXISTS returns (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  supplier      text    NOT NULL,
  department    text    NOT NULL CHECK (department IN ('FOOD', 'NONFOOD', 'FRESH MARKET')),
  brand         text    NOT NULL DEFAULT '',

  -- RPO numbers are NOT unique in the real data (8 repeats in July 2026 alone:
  -- split cartons, same RPO under two suppliers), so this is indexed only.
  rpo_no        text    NOT NULL,

  -- Nullable on purpose: 24 July rows have a blank Total Item, and one row has
  -- a blank RPO Date. Tighten later in the API/UI if you want to require them.
  total_item    integer CHECK (total_item   IS NULL OR total_item   >= 0),
  total_carton  integer CHECK (total_carton IS NULL OR total_carton >= 0),
  rpo_date      date,

  reason        text    NOT NULL CHECK (reason IN ('DAMAGED', 'EXPIRED', 'OTHERS')),
  submitted_by  text    NOT NULL,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  remark        text    NOT NULL DEFAULT '',

  status        text    NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING', 'RETURNED', 'DISPOSED', 'OTHERS')),
  pickup_date   date,
  updated_by    text,
  updated_at    timestamptz,

  -- Traceability back to the Google Sheet. NULL for rows created in the new app.
  -- The unique pair is what makes the migration script safe to re-run.
  legacy_sheet  text,
  legacy_row    integer,
  CONSTRAINT returns_legacy_unique UNIQUE (legacy_sheet, legacy_row)
);

CREATE INDEX IF NOT EXISTS returns_pending_idx  ON returns (supplier, rpo_date) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS returns_rpo_no_idx   ON returns (rpo_no);
CREATE INDEX IF NOT EXISTS returns_status_idx   ON returns (status);
CREATE INDEX IF NOT EXISTS returns_rpo_date_idx ON returns (rpo_date);

-- Replaces the old "Master Log" tab: pending items only, oldest first per supplier.
CREATE OR REPLACE VIEW pending_returns AS
SELECT r.*,
       CASE WHEN r.rpo_date IS NULL THEN NULL
            ELSE (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date - r.rpo_date
       END AS age_days
FROM returns r
WHERE r.status = 'PENDING'
ORDER BY r.supplier, r.rpo_date NULLS LAST, r.id;
