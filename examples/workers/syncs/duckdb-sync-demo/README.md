# Worker sync: DuckDB demo

A self-contained sync worker that seeds an in-memory DuckDB database with
sample sales data and syncs the `customers` table into a managed Notion
database. No external database, no credentials, no environment variables
required.

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

## Setup

Install the Notion workers CLI:

```
npm install -g @notionhq/workers-cli
```

Clone the repo and install dependencies:

```
cd examples/workers/syncs/duckdb-sync-demo
npm install
```

Authenticate:

```
ntn login
```

Deploy the worker:

```
ntn workers deploy
```

Trigger a dry run to preview changes without writing to Notion:

```
ntn workers sync trigger customersSync --preview
```

Trigger a real sync to write rows into the managed Notion database:

```
ntn workers sync trigger customersSync
```

## Local checks

```
npm run check   # TypeScript type-check (no output = clean)
npm run build   # Compile to dist/
npm test        # Run offline assertions against the seeded DB
```
