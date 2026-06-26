# Worker tool: SQLite demo

A self-contained Notion worker that lets a custom agent query an in-memory
SQLite database seeded with sample sales data. No external database, no
credentials, no environment variables — deploy it and start querying
immediately.

The database resets each time the worker process starts. It is designed for
demos, onboarding, and learning the worker tool pattern, not for persisting
real data.

## Seeded schema

Four tables are created and populated on startup:

```text
customers   (id, name, email, country, signup_date)          8 rows
products    (id, name, category, price)                       6 rows
orders      (id, customer_id, order_date, status, total)     15 rows
order_items (id, order_id, product_id, quantity, unit_price) 28 rows
```

Products span three categories (Subscription, Services, Add-on). Orders
have statuses `completed`, `refunded`, and `pending`.

## Tools

The worker registers three tools:

- `listTables` — lists the four tables in the demo database.
- `describeTable` — returns column names and types for a given table via
  `PRAGMA table_info`.
- `query` — runs a single read-only `SELECT` (or `WITH ... SELECT`) and
  returns the rows, capped at `maxRows` (default 100, max 1000).

Example questions an agent can answer out of the box:

- Who are the top customers by total spend?
- What is revenue by product category?
- How many orders are in each status?
- Which products appear most often in completed orders?

## How it works

The SQLite database is opened with Node's built-in `node:sqlite` module
(`DatabaseSync` from `node:sqlite`, available flag-free in Node 22+). No
third-party database driver is needed.

`query` parses the SQL with `node-sql-parser` (SQLite dialect) and only
allows a single `SELECT` or `WITH ... SELECT`. Writes are rejected before
execution, not just by database-level permissions.

`describeTable` uses `PRAGMA table_info(<table>)`, which cannot be
parameterized. The table name is validated against a strict identifier regex
(`/^[A-Za-z0-9_$]+$/`) before interpolation.

## Project structure

```text
src/
  index.ts   Worker definition and the three tools
  sql.ts     Read-only SQL guard, buildBoundedQuery, catalog helpers
  sqlite.ts  Database singleton, query execution, result normalization
  seed.ts    Schema DDL and deterministic INSERT statements
test.ts      Offline end-to-end tests (no network or credentials required)
```

## Setup

### 1. Install the Notion Workers CLI

```zsh
npm install -g @notionhq/workers-cli
```

### 2. Clone and install

```zsh
git clone https://github.com/makenotion/notion-cookbook.git
cd notion-cookbook/examples/workers/tools/sqlite-demo
npm install
```

### 3. Connect to your workspace

```zsh
ntn login
```

### 4. Deploy

```zsh
ntn workers deploy --name sqlite-demo
```

No environment variables are needed. The worker is ready as soon as it deploys.

## Connect it to an agent

Once deployed, add the worker to a custom agent under
**Tools and access > Add connection**. The agent can then call `listTables`,
`describeTable`, and `query`.

A prompt like:

> Who are the top three customers by total spend? Use the demo database.

usually has the agent list tables, describe `orders` and `customers`, join
them, and summarize the result.

## Local testing

Run the offline test suite (no network or credentials required):

```zsh
npm test
```

Run a tool locally without deploying:

```zsh
ntn workers exec listTables --local -d '{}'
ntn workers exec describeTable --local -d '{"table": "orders"}'
ntn workers exec query --local \
  -d '{"sql": "SELECT name, country FROM customers ORDER BY name", "maxRows": 10}'
```

## Notes

- Data is ephemeral. The in-memory database resets when the worker process
  restarts. It is not intended for production use.
- This worker uses Node's built-in `node:sqlite` module (Node 22+), which
  requires no additional npm dependencies beyond `node-sql-parser`.
- For a worker that connects to a real external database, see
  `../postgres-query` or `../snowflake-query`.

## Learn more

- [Notion Workers documentation](https://developers.notion.com/docs/workers)
- [node:sqlite documentation](https://nodejs.org/api/sqlite.html)
- [Contribute to this cookbook](../../../../CONTRIBUTING.md)
