# Worker Sync: Snowflake

A Notion worker sync that runs a single `SELECT` against your Snowflake warehouse and writes each row into a Notion database, keeping it up to date on a schedule.

Out of the box it syncs your **table catalog** — the tables and views in your configured database/schema, from `INFORMATION_SCHEMA.TABLES`. That query needs no special grants (any role can read the `INFORMATION_SCHEMA` of a database it can use), so it works on any account without setup beyond credentials. Point it at your own query when you're ready.

## How it works

- `worker.database(...)` declares the Notion database (its title, primary key, and property schema). Notion creates and migrates this database for you on deploy.
- `worker.sync(...)` runs on a schedule, calls `runQuery` for a page of rows, and returns them as `upsert` changes keyed by the primary key.
- The sync uses **`mode: "replace"`** because a plain `SELECT` has no change feed: each cycle re-pulls the full result set, and rows that no longer appear are deleted.
- Pagination is done with `LIMIT ... OFFSET`. Each `execute` returns one page plus a `nextState` offset; the runtime calls `execute` again until a page comes back short.

```
src/
  index.ts       Worker: the database schema, the sync, and the row → property mapping
  snowflake.ts   Connection, query execution, and result normalization
```

The default query lists tables in the connection's current schema, so it relies on `SNOWFLAKE_DATABASE` and `SNOWFLAKE_SCHEMA` being set (so `CURRENT_SCHEMA()` resolves). It maps each row to: `Name` (table name), `Full Name` (the fully-qualified name, used as the primary key), `Schema`, `Type` (`BASE TABLE` / `VIEW`), and `Rows` (row count).

## Set up Snowflake

The worker connects as a Snowflake user, so give it a dedicated read-only one scoped to just the data the sync should see.

Run this in a worksheet, replacing `MY_DB` with the database you want to sync:

```sql
USE ROLE SECURITYADMIN;
CREATE ROLE IF NOT EXISTS NOTION_SYNC_READONLY;

CREATE WAREHOUSE IF NOT EXISTS NOTION_SYNC_WH
  WITH WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE;
GRANT USAGE ON WAREHOUSE NOTION_SYNC_WH TO ROLE NOTION_SYNC_READONLY;

-- USAGE lets the role see the catalog; SELECT is needed once you query real tables.
GRANT USAGE ON DATABASE MY_DB TO ROLE NOTION_SYNC_READONLY;
GRANT USAGE ON ALL SCHEMAS IN DATABASE MY_DB TO ROLE NOTION_SYNC_READONLY;
GRANT SELECT ON ALL TABLES IN DATABASE MY_DB TO ROLE NOTION_SYNC_READONLY;
GRANT SELECT ON ALL VIEWS IN DATABASE MY_DB TO ROLE NOTION_SYNC_READONLY;

USE ROLE USERADMIN;
CREATE USER IF NOT EXISTS NOTION_SYNC_SVC
  DEFAULT_ROLE = NOTION_SYNC_READONLY
  DEFAULT_WAREHOUSE = NOTION_SYNC_WH;
GRANT ROLE NOTION_SYNC_READONLY TO USER NOTION_SYNC_SVC;
```

### Key-pair authentication

The worker authenticates with an RSA key pair rather than a password. Generate one:

```zsh
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out rsa_key.p8 -nocrypt
openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub
```

Attach the public key to the service user. Paste the body of `rsa_key.pub` without the `BEGIN`/`END` lines:

```sql
ALTER USER NOTION_SYNC_SVC SET RSA_PUBLIC_KEY='MIIBIjANBgkqh...';
```

`rsa_key.p8` stays on your machine and is only ever passed to the worker as a secret. The `.gitignore` here ignores `*.p8` and `rsa_key*` so it won't get committed by accident.

## Setup

### 1. Install the Notion Workers CLI

```zsh
npm install -g @notionhq/workers-cli
```

### 2. Clone and install

```zsh
git clone https://github.com/makenotion/notion-cookbook.git
cd notion-cookbook/examples/workers/syncs/snowflake
npm install
```

### 3. Connect to your workspace

```zsh
ntn login
```

### 4. Deploy

```zsh
ntn workers deploy --name snowflake-sync
```

On first deploy, Notion creates the **Snowflake Tables** database for you.

### 5. Set the connection secrets

These are worker secrets and never live in the repo (`.env` and `workers.json` are gitignored):

```zsh
ntn workers env set SNOWFLAKE_ACCOUNT=your_org-your_account
ntn workers env set SNOWFLAKE_USER=NOTION_SYNC_SVC
ntn workers env set SNOWFLAKE_WAREHOUSE=NOTION_SYNC_WH
ntn workers env set SNOWFLAKE_PRIVATE_KEY="$(cat rsa_key.p8)"

# The default query lists tables in this schema, so set both:
ntn workers env set SNOWFLAKE_DATABASE=MY_DB
ntn workers env set SNOWFLAKE_SCHEMA=PUBLIC

# Optional:
ntn workers env set SNOWFLAKE_ROLE=NOTION_SYNC_READONLY
```

`SNOWFLAKE_ACCOUNT` is the `orgname-account_name` identifier ([docs](https://docs.snowflake.com/en/user-guide/admin-account-identifier)). Other optional secrets: `SNOWFLAKE_PRIVATE_KEY_PASS` if the key is encrypted, and `SNOWFLAKE_QUERY_TIMEOUT_SECONDS` (default 60, capped at 300).

### 6. Trigger the first run

The sync runs hourly by default. To pull immediately:

```zsh
ntn workers sync trigger snowflakeSync
ntn workers sync status snowflakeSync
```

## Sync your own data

The default query and the database schema are wired together in `src/index.ts`. To sync a different table:

1. Set `SNOWFLAKE_SYNC_QUERY` to your `SELECT`. Leave off `LIMIT`/`OFFSET` (the sync adds them to paginate) and include an `ORDER BY` so paging is stable.

   ```zsh
   ntn workers env set SNOWFLAKE_SYNC_QUERY="SELECT ID, NAME, AMOUNT FROM MY_DB.PUBLIC.ORDERS ORDER BY ID"
   ```

2. Update the `worker.database(...)` schema, its `primaryKeyProperty`, and the `rowToEntry` mapping in `src/index.ts` so the property names and types match your columns.
3. Redeploy. Schema changes migrate the database; `ntn workers deploy` does **not** reset sync state, so use `ntn workers sync state reset snowflakeSync` if you want a clean re-pull.

## Test locally

Copy `.env.example` to `.env`, fill in your values, and preview the sync without writing to Notion:

```zsh
ntn workers sync trigger snowflakeSync --preview
```

Preview calls `execute` and prints the rows it would produce. Run a real cycle (writes to the database) with `ntn workers sync trigger snowflakeSync`.

## Notes

- **`replace` vs `incremental`:** this example uses `replace` because a generic `SELECT` can't tell you what changed. If your source tracks changes (an `UPDATED_AT` column, a stream, a CDC table), switch to `mode: "incremental"`, filter by a cursor stored in `nextState`, and emit `{ type: "delete", key }` markers for removed rows. See the [Workers sync docs](https://developers.notion.com/docs/workers).
- **Batch size:** rows are paged at 100 per `execute`. Returning too many changes in one call can fail, so keep batches around this size.
- **Read-only by design:** the sync only ever reads. A read-only Snowflake role like the one above is what enforces that at the warehouse — not the worker code.

## Learn more

- [Notion Workers documentation](https://developers.notion.com/docs/workers)
- [Snowflake key-pair authentication](https://docs.snowflake.com/en/user-guide/key-pair-auth)
- [Snowflake INFORMATION_SCHEMA](https://docs.snowflake.com/en/sql-reference/info-schema)
- [Contribute to this cookbook](../../../../CONTRIBUTING.md)
