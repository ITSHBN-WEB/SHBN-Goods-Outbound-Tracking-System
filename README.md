# SHBN Goods Outbound Tracking System (formerly Supplier Return Log)

Web app + Vercel API on Neon Postgres. The repo is only 10 files (fits the Vercel free plan):

- `index.html` - the web app
- `api/` - 6 serverless functions: `init`, `pending-count`, `suppliers`, `summary`, `returns/index`, `returns/[id]`
- `lib/core.js` - shared code (database, CORS/PIN, validation, queries)
- `package.json`

## Deploy
1. **Neon** (SQL Editor): run `schema.sql` (tables), then `suppliers.sql` (vendor list). Both are separate files, not part of this repo. Skip `schema.sql` if the migration already created the tables.
2. **GitHub**: create a repo under `itshbn-web` and upload these 10 files, keeping the folder structure.
3. **Vercel**: Add New > Project > import the repo. Framework preset "Other", no build command.
4. **Environment variables** (Settings > Environment Variables), then Redeploy:
   - `DATABASE_URL` - Neon connection string (required)
   - `APP_PIN` - shared PIN, users enter it once per device (optional, recommended)
   - `ALLOWED_ORIGINS` - extra allowed websites, comma-separated (optional; GitHub Pages is already allowed)
5. If the page is also hosted on GitHub Pages, set `API_URL` at the top of the script in `index.html` to your Vercel URL.

## Endpoints
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/init` | dropdown lists + pending count |
| GET | `/api/pending-count` | `{pendingCount, overdueCount}` (open, for Control Tower) |
| GET | `/api/suppliers` | vendor list for the supplier type-ahead |
| GET | `/api/summary` | summary report, grouped by supplier, oldest first |
| GET / POST | `/api/returns` | list pending / submit batch |
| PATCH / DELETE | `/api/returns/:id` | update status / delete (pending only) |

## Control Tower
Point the card's pending-count URL to `https://<your-project>.vercel.app/api/pending-count`.

## Goods Transfer Record (inter-outlet transfers)

Sidebar group "GOODS TRANSFER": New Transfer, Pending Transfers, Awaiting Copy-Document, Completed Transfers, Transfer Summary.

Two-step flow (single or bulk at each step):
1. **Pending** - enter DO No, Pickup Date and Updated By -> moves to **Awaiting Copy-Document**.
2. **Awaiting Copy-Document** - search the ODO number, enter the Returned Copy-Document Date and Submitted By -> **Completed**.
"Back to ..." steps a transfer back one stage. Attachments (pictures/PDF, up to 10 per transfer, 5 per upload) can be added or removed in any status from the transfer detail screen.

One-time setup:
1. Neon SQL Editor: run `transfers.sql` (tables `outlets` and `transfers`; safe to re-run - it also upgrades an existing table to the two-step flow; outlets are seeded from the 4-digit store codes in `suppliers`).
2. Vercel project > Storage > create a **Blob** store and connect it to the project (adds `BLOB_STORE_ID`, or `BLOB_READ_WRITE_TOKEN` on older stores), then redeploy. Without it everything works except attachments.

API: `GET/POST/PATCH /api/transfers`, `PUT/PATCH/DELETE /api/transfers/:id`, `POST /api/transfers/upload`.
