# Worker tool: Snowflake query

**TL;DR:** Connect a read-only slice of Snowflake to a Notion Agent so it can
discover warehouse tables, write SQL, and answer data questions in the
conversation.

## Quickstart

First provision a dedicated user and key pair using
[Set up Snowflake](#set-up-snowflake). Then deploy the worker with those
credentials. From the repository root:

```zsh
npm install --global ntn
cd workers/snowflake-query
npm install
ntn login
ntn workers deploy --name snowflake-query
ntn workers env set SNOWFLAKE_ACCOUNT=your_org-your_account
ntn workers env set SNOWFLAKE_USER=NOTION_AGENT_SVC
ntn workers env set SNOWFLAKE_WAREHOUSE=NOTION_AGENT_WH
ntn workers env set SNOWFLAKE_PRIVATE_KEY="$(cat rsa_key.p8)"
ntn workers env set SNOWFLAKE_DATABASE=MY_DB
ntn workers env set SNOWFLAKE_SCHEMA=PUBLIC
ntn workers env set SNOWFLAKE_ROLE=NOTION_AGENT_READONLY
```

In Notion, add the deployed worker to a custom agent under
**Tools and access > Add connection**.

## Try asking

- "What were total orders by month this year? Find the right table first."
- "Which products grew fastest quarter over quarter?"
- "Compare customer retention by acquisition channel."
- "Describe `MY_DB.PUBLIC.ORDERS` and summarize what it can answer."

The worker registers three tools:

- `listTables` runs `SHOW TABLES`, optionally scoped to a database/schema or filtered with a `LIKE` pattern.
- `describeTable` runs `DESCRIBE TABLE` and returns a table's columns and types.
- `query` runs a single read-only `SELECT` (or `WITH ... SELECT`) and returns the rows.

Together they let the agent find a table, check its columns, and query it without anyone writing SQL by hand. Everything runs on Notion Workers against your warehouse, so there's no separate service to host.

## Project structure

```
src/
  index.ts       Worker definition and the three tools
  sql.ts         Read-only SQL validation and the SHOW/DESCRIBE builders
  snowflake.ts   Connection, query execution, and result normalization
```

## Set up Snowflake

The worker connects as a Snowflake user, so give it a dedicated read-only one scoped to just the data the agent should see. That read-only role, not the SQL check in the code, is what actually keeps the agent from writing.

Run this in a worksheet, replacing `MY_DB` with your database:

```sql
USE ROLE SECURITYADMIN;
CREATE ROLE IF NOT EXISTS NOTION_AGENT_READONLY;

USE ROLE SYSADMIN;
CREATE WAREHOUSE IF NOT EXISTS NOTION_AGENT_WH
  WITH WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE;
GRANT USAGE ON WAREHOUSE NOTION_AGENT_WH TO ROLE NOTION_AGENT_READONLY;

GRANT USAGE ON DATABASE MY_DB TO ROLE NOTION_AGENT_READONLY;
GRANT USAGE ON ALL SCHEMAS IN DATABASE MY_DB TO ROLE NOTION_AGENT_READONLY;
GRANT USAGE ON FUTURE SCHEMAS IN DATABASE MY_DB TO ROLE NOTION_AGENT_READONLY;
GRANT SELECT ON ALL TABLES IN DATABASE MY_DB TO ROLE NOTION_AGENT_READONLY;
GRANT SELECT ON FUTURE TABLES IN DATABASE MY_DB TO ROLE NOTION_AGENT_READONLY;
GRANT SELECT ON ALL VIEWS IN DATABASE MY_DB TO ROLE NOTION_AGENT_READONLY;
GRANT SELECT ON FUTURE VIEWS IN DATABASE MY_DB TO ROLE NOTION_AGENT_READONLY;

USE ROLE USERADMIN;
CREATE USER IF NOT EXISTS NOTION_AGENT_SVC
  DEFAULT_ROLE = NOTION_AGENT_READONLY
  DEFAULT_WAREHOUSE = NOTION_AGENT_WH;

USE ROLE SECURITYADMIN;
GRANT ROLE NOTION_AGENT_READONLY TO USER NOTION_AGENT_SVC;
```

### Key-pair authentication

The worker authenticates with an RSA key pair rather than a password. Generate one:

```zsh
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out rsa_key.p8 -nocrypt
openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub
```

Attach the public key to the service user. Paste the body of `rsa_key.pub` without the `BEGIN`/`END` lines:

```sql
ALTER USER NOTION_AGENT_SVC SET RSA_PUBLIC_KEY='MIIBIjANBgkqh...';
```

`rsa_key.p8` stays on your machine and is only ever passed to the worker as a secret. The `.gitignore` here ignores `*.p8` and `rsa_key*` so it won't get committed by accident.

## Connection settings

Worker secrets never live in the repo (`.env` and `workers.json` are
gitignored). `SNOWFLAKE_ACCOUNT` is the `orgname-account_name` identifier
([docs](https://docs.snowflake.com/en/user-guide/admin-account-identifier)).
The database, schema, and role in the quickstart are optional; setting them
means the agent does not have to fully qualify every name. Other optional
secrets are `SNOWFLAKE_PRIVATE_KEY_PASS` for an encrypted key,
`SNOWFLAKE_MAX_ROWS` (default 100, capped at 1000), and
`SNOWFLAKE_QUERY_TIMEOUT_SECONDS` (default 60, capped at 300).

## Run locally

Copy `.env.example` to `.env`, fill in your values, and run a tool without deploying:

```zsh
ntn workers exec listTables --local -d '{"database": null, "schema": null, "like": null}'
ntn workers exec describeTable --local -d '{"table": "MY_DB.PUBLIC.ORDERS"}'
ntn workers exec query --local -d '{"sql": "SELECT CURRENT_DATE() AS ds", "maxRows": 10}'
```

## Notes on safety

`query` parses each statement and only allows a single `SELECT`/`WITH ... SELECT`; writes, DDL, and multiple statements are rejected, and the discovery tools build their SQL from validated identifiers. Treat that as a guardrail, not a guarantee: the read-only role above is what enforces it at the warehouse. Results are also capped (`SNOWFLAKE_MAX_ROWS`, max 1000) and run under a statement timeout, so this is meant for answering questions inline, not bulk export.

The row cap is applied with an outer `LIMIT`, which doesn't preserve a top-level `ORDER BY` on its own. If order matters, have the query sort and bound its own rows (`ORDER BY ... LIMIT`), or sort the returned rows in the agent.

The read-only check uses `node-sql-parser`'s Snowflake dialect, which fails closed: it rejects anything it can't parse as a single `SELECT`. That's safe, but it also means a few valid read-only queries it doesn't fully support yet (e.g. `SAMPLE`) get bounced. The authoritative guardrail is still the read-only role, so you can loosen the parser check if your use case needs those.

## Learn more

- [Notion Workers documentation](https://developers.notion.com/docs/workers)
- [Snowflake key-pair authentication](https://docs.snowflake.com/en/user-guide/key-pair-auth)
- [Contribute to this cookbook](../../CONTRIBUTING.md)
