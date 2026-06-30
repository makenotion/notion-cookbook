# Worker sync: Snowflake

Syncs rows from a Snowflake query into a managed Notion database. The worker
declares the schema; Notion auto-provisions and owns the database. Each run
fetches the full result set in 200-row pages and upserts every row by the `ID`
column. Rows removed from the source query are removed from the Notion database
on the next full sync (`mode: "replace"`).

## How it works

1. You provide a `SNOWFLAKE_SYNC_QUERY` — any `SELECT` that returns an `id`
   column (case-insensitive) plus whatever columns you want to show in Notion.
2. On each sync run the worker pages through the query results (200 rows at a
   time, using `LIMIT`/`OFFSET`) and emits an `upsert` change for every row.
3. The platform applies those changes to the managed database and loops until
   `hasMore` is false.

The example schema maps `id, name, email, status, updated_at`. See
[Adapting to your query](#adapting-to-your-query) to change it.

## Prerequisites

- Node >= 22, npm >= 10.9.2
- A Snowflake account with a read-only service role and an RSA key pair for
  JWT authentication. See the
  [snowflake-query README](../snowflake-query/README.md) for key-pair
  setup instructions.
- The `ntn` CLI installed and authenticated (`ntn login`).

## Environment variables

### Required

| Variable                | Description                                                                   |
| ----------------------- | ----------------------------------------------------------------------------- |
| `SNOWFLAKE_ACCOUNT`     | Account identifier (e.g. `xy12345.us-east-1`)                                 |
| `SNOWFLAKE_USER`        | Snowflake username                                                            |
| `SNOWFLAKE_WAREHOUSE`   | Warehouse to use for queries                                                  |
| `SNOWFLAKE_PRIVATE_KEY` | Full PEM private key. Literal `\n` sequences are normalized automatically.    |
| `SNOWFLAKE_SYNC_QUERY`  | The `SELECT` statement to sync (trailing semicolon is stripped automatically) |

### Optional

| Variable                     | Default            | Description                                   |
| ---------------------------- | ------------------ | --------------------------------------------- |
| `SNOWFLAKE_PRIVATE_KEY_PASS` | —                  | Passphrase for an encrypted private key       |
| `SNOWFLAKE_DATABASE`         | —                  | Default database for the session              |
| `SNOWFLAKE_SCHEMA`           | —                  | Default schema for the session                |
| `SNOWFLAKE_ROLE`             | —                  | Role to assume for the query                  |
| `SNOWFLAKE_SYNC_DB_TITLE`    | `"Snowflake Sync"` | Title of the auto-provisioned Notion database |

No `NOTION_API_TOKEN` is needed. The platform manages the database and handles
the Notion credentials automatically.

## Setup and deploy

```sh
# Install dependencies
cd workers/snowflake-sync
npm install

# Typecheck
npm run check

# Build
npm run build

# Run offline tests
npm test
```

Deploy the worker:

```sh
ntn workers deploy
```

Set environment variables on the deployed worker:

```sh
ntn workers env set SNOWFLAKE_ACCOUNT=xy12345.us-east-1
ntn workers env set SNOWFLAKE_USER=svc_notion_sync
ntn workers env set SNOWFLAKE_WAREHOUSE=COMPUTE_WH
ntn workers env set SNOWFLAKE_PRIVATE_KEY="$(cat rsa_key.p8)"
ntn workers env set SNOWFLAKE_SYNC_QUERY="SELECT id, name, email, status, updated_at FROM my_db.my_schema.my_table"
```

Preview a sync without writing to Notion:

```sh
ntn workers sync trigger snowflakeSync --preview
```

Run a real sync:

```sh
ntn workers sync trigger snowflakeSync
```

## Adapting to your query

The example targets five columns. To match your own query, edit two files:

**`src/schema.ts`** — declares the Notion database properties. Each key is a
property name; the value is a Schema factory call. Supported types include
`Schema.title()`, `Schema.richText()`, `Schema.email()`, `Schema.date()`,
`Schema.select([...])`, `Schema.number()`, `Schema.url()`, and
`Schema.checkbox()`. Keep `PRIMARY_KEY` pointing at the property that holds
the unique row identifier.

**`src/transform.ts`** — maps a raw Snowflake row to a sync change. Column
lookups use `row["COLUMN"] ?? row["column"]` to handle Snowflake's UPPERCASE
default and explicit lowercase aliases. Add or remove `Builder.*` calls to
match your schema.

## Pagination

The worker uses `LIMIT 200 OFFSET N` to page through results. The platform
loops execute() calls until `hasMore` is false. For queries returning millions
of rows this is reliable but sequential. An `ORDER BY` clause in
`SNOWFLAKE_SYNC_QUERY` is recommended to make pages deterministic.

## Incremental syncs for large or frequently-changing tables

`mode: "replace"` re-syncs the entire result set on every run. For large tables
or tables that change often, switch to `mode: "incremental"` and carry a cursor
in `nextState`:

```ts
// In execute():
const since = state?.updatedSince ?? "1970-01-01"
const query = `${baseQuery} WHERE updated_at > '${since}' ORDER BY updated_at`
// ...
return {
  changes,
  hasMore: false,
  nextState: { updatedSince: latestUpdatedAt },
}
```

Incremental mode also supports `type: "delete"` changes for rows removed from
the source.

## Access control

The worker connects using the Snowflake role configured via `SNOWFLAKE_ROLE` (or
the user's default role). Use a read-only role that has `SELECT` privileges only
on the tables your query references. The role's grants are the effective read
boundary — the worker cannot access tables the role cannot see.
