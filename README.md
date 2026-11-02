# SHBN Goods Outbound Tracking System (formerly Supplier Return Log) (Vercel + Neon)

- `index.html` – the web app (served by Vercel, or by GitHub Pages)
- `api/` – serverless functions: `init`, `pending-count`, `summary`, `returns`, `returns/[id]`
- `lib/` – shared code (database, validation, CORS/PIN)
- `db/schema.sql` – database tables (already created if your migration worked)

## Deploy

1. **GitHub**: create the repo (any name, e.g. `SHBN-GOODS-OUTBOUND-TRACKING-SYSTEM`) under `itshbn-web`, upload everything in this folder (not `db/` is fine to include too).
2. **Vercel**: Add New > Project > import the repo. Framework preset: *Other*. No build command.
3. **Environment variables** (Project > Settings > Environment Variables):
   - `DATABASE_URL` = your Neon connection string (required)
   - `APP_PIN` = a PIN (optional, recommended)
   - `ALLOWED_ORIGINS` (optional)
   Then **Redeploy** so they take effect.
4. Open `https://<your-project>.vercel.app` – the app should load and show the pending count.
5. If your Vercel URL is not `shbn-goods-outbound-tracking-system.vercel.app`, edit `API_URL` near the top of the script in `index.html` (only needed if you also host the page on GitHub Pages).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/init` | dropdown lists + pending count |
| GET | `/api/pending-count` | `{pendingCount, overdueCount}` (open, for Control Tower) |
| GET | `/api/summary` | summary report, grouped by supplier, oldest first |
| GET / POST | `/api/returns` | list pending / submit batch |
| PATCH / DELETE | `/api/returns/:id` | update status / delete (pending only) |

## Control Tower
Point the Goods Outbound Tracking System card's pending-count URL to
`https://<your-project>.vercel.app/api/pending-count` (same JSON shape as before).
