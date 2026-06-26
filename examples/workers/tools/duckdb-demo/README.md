# Worker tool: DuckDB demo

A self-contained Notion worker that lets a custom agent query an in-memory
DuckDB database seeded with sample sales data. No external database, no
credentials, no environment variables required — deploy it and it is ready to
query immediately.

It registers three tools:

- `listTables` lists the four seeded tables.
- `describeTable` returns a table's columns, types, and nullability.
- `query` runs a single read-only `SELECT` (or `WITH ... SELECT`) and returns
  the rows.

This is designed for demos, workshops, and learning how Notion Workers and DuckDB
work together. The in-memory database resets each time the worker process
restarts; no data is persisted between runs.

## Demo database schema

The database is seeded with a small sales dataset on startup:

```text
customers(id, name, email, country, signup_date)
  8 rows — companies from US, GB, CA, DE, AU, FR, SG

products(id, name, category, price)
  6 rows — Subscription / Services / Add-on categories

orders(id, customer_id, order_date, status, total)
  15 rows — statuses: completed, pending, refunded

order_items(id, order_id, product_id, quantity, unit_price)
  30 rows — line items linking orders to products
```

The data is consistent with the `sqlite-demo` worker so both examples produce
the same answers.

## Project structure

```text
src/
  index.ts    Worker definition and the three tools
  sql.ts      Read-only SQL validation and query builders
  duckdb.ts   DuckDB instance, seeding, execution, and result normalization
  seed.ts     Schema DDL and deterministic INSERT data
```

## Example questions to ask the agent

Connect the worker to a custom agent, then try:

- Which customers have spent the most (excluding refunds)?
- What is total revenue by product category?
- How many orders are in each status?
- Show monthly order volume for 2024.
- Which products appear in the most orders?

## Setup

### 1. Install the Notion Workers CLI

```zsh
npm install -g @notionhq/workers-cli
```

### 2. Clone and install

```zsh
git clone https://github.com/makenotion/notion-cookbook.git
cd notion-cookbook/examples/workers/tools/duckdb-demo
npm install
```

### 3. Connect to your workspace

```zsh
ntn login
```

### 4. Deploy

```zsh
ntn workers deploy --name duckdb-demo
```

No environment variables are needed. The demo database is created and seeded
in memory at startup.

## Connect it to an agent

Once deployed, add the worker to a custom agent under
**Tools and access > Add connection**. The agent can then call `listTables`,
`describeTable`, and `query`.

A prompt like:

> Which customers have spent the most? Exclude refunded orders.

will have the agent list tables, describe the relevant ones, run a join, and
summarize the result.

## Local testing

Run the offline test suite (no database, no network required):

```zsh
npm test
```

The tests seed the in-memory database and assert against real query results,
so they cover the full end-to-end path.

Type-check without building:

```zsh
npm run check
```

## Notes

- The in-memory database is ephemeral. Every time the worker process starts, it
  re-seeds from the hardcoded INSERT statements in `src/seed.ts`. Restarting
  the process discards any writes that might have occurred via direct DuckDB
  API access (the `query` tool itself is read-only).
- `query` uses a lightweight keyword check to reject non-SELECT statements
  (no SQL parser dependency). This is a convenience guard, **not** the security
  boundary. DuckDB can read host files and the network from inside a `SELECT`
  via table functions (`read_csv`, `read_text`, `glob`, and httpfs
  `read_json`/`read_parquet`), which a keyword check cannot catch. The real
  boundary is that the engine is created with `enable_external_access: "false"`
  (see `src/duckdb.ts`), which disables those functions — so agent SQL cannot
  read the host filesystem or make network calls. If you adapt this example, keep
  external access disabled for any engine that runs agent-supplied SQL. For a
  full parser-based guard see the `postgres-query` or `snowflake-query` examples.
- The engine is also bounded with `memory_limit` and `threads` so a single
  expensive query can't exhaust the worker.
- Results are capped at 100 rows by default (hard cap 1000).

## Learn more

- [Notion Workers documentation](https://developers.notion.com/docs/workers)
- [DuckDB node-api](https://github.com/duckdb/duckdb-node-neo/tree/main/api)
- [Contribute to this cookbook](../../../../CONTRIBUTING.md)
