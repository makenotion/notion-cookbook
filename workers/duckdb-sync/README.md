# Worker sync: DuckDB

A no-credentials starting point for putting database rows into Notion. Deploy
and trigger it to create a managed **Demo Customers** database with eight sample
customers, then use the code as a template for your own sync.

DuckDB and the sample data run entirely inside the worker. You do not need an
external database, environment variables, or a Notion API token.

## Quickstart

From the repository root, install the CLI and project dependencies, connect
your workspace, and deploy:

```sh
npm install --global ntn
cd workers/duckdb-sync
npm install
ntn login
ntn workers deploy --name duckdb-sync
```

Preview the eight customer rows without changing Notion, then run the sync:

```sh
ntn workers sync trigger customersSync --preview
ntn workers sync trigger customersSync
```

The real run creates **Demo Customers** in your workspace. The sync is manual,
so it runs only when you trigger it.

## What this helps you answer

| Managed database | Example questions                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------- |
| Demo Customers   | Who are the newest customers? Which countries are represented? How can I contact a customer? |

Only the `customers` table is synced. The other seeded tables demonstrate how
a real source database might be structured and are available when you extend
the worker.

## How it works

### Managed databases

This worker declares a managed database. The Notion platform auto-provisions
the database on first deploy and migrates its schema on subsequent deploys.
Users can rename, move, and share the database freely — the worker owns the
schema and data, not the page title or location.

### Sync mode

The worker uses `mode: "replace"` with `schedule: "manual"`. On each run the
worker returns the complete set of customer rows. After `hasMore: false`, the
platform performs mark-and-sweep: any page whose `Customer ID` was not seen in
this run is archived. This keeps the Notion database in sync with the source
without explicit delete markers.

### Primary key

Each change carries a `key` matching the `Customer ID` property value. The
platform uses this key to match incoming upserts against existing pages.

### In-memory data

DuckDB is initialised with `:memory:` and seeded on startup. Data is ephemeral
— each worker process seeds fresh. For a real sync worker you would query an
external database instead.

## Seeded schema

| Table       | Rows | Notes                                 |
| ----------- | ---- | ------------------------------------- |
| customers   | 8    | Synced to Notion                      |
| products    | 6    | Subscriptions, services, add-ons      |
| orders      | 15   | completed / refunded / pending        |
| order_items | 30   | Line items linking orders to products |

Customer countries in the dataset: AU, CA, DE, FR, GB, SG, US.

## Local checks

```sh
npm run check   # TypeScript type-check (no output = clean)
npm run build   # Compile to dist/
npm test        # Run offline assertions against the seeded DB
```
