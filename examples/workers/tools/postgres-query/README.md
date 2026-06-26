# Worker tool: Postgres query

A Notion worker that lets a custom agent query your Postgres database and get
the rows back in the conversation. It registers three tools:

- `listTables` queries `information_schema.tables`, optionally scoped to a
  schema or filtered with an ILIKE pattern.
- `describeTable` queries `information_schema.columns` and returns a table's
  columns, types, and nullability.
- `query` runs a single read-only `SELECT` (or `WITH ... SELECT`) and returns
  the rows.

Together they let the agent find a table, check its columns, and query it
without anyone writing SQL by hand. Everything runs on Notion Workers against
your database, so there's no separate service to host.

## Project structure

```text
src/
  index.ts     Worker definition and the three tools
  sql.ts       Read-only SQL validation and the information_schema builders
  postgres.ts  Connection, query execution, and result normalization
```

## How it works

`listTables` and `describeTable` use parameterized `information_schema` queries,
so table and schema names are always passed as bind values rather than
interpolated into SQL. `query` parses the SQL with `node-sql-parser` (Postgres
dialect) and only allows a single `SELECT` or `WITH ... SELECT`. Every `query`
call also runs inside a `BEGIN` / `SET TRANSACTION READ ONLY` / `ROLLBACK`
block as a second layer of defense.

> **Note:** The real security boundary is a read-only Postgres role. The
> parse check and read-only transaction are convenience layers, not guarantees.
> Create a dedicated user with only `GRANT SELECT` and `GRANT USAGE` on the
> schemas the agent should see (see "Set up Postgres" below).
>
> **Note on error messages:** database and parser errors are returned to the
> agent verbatim to help it self-correct, which can disclose schema, column, or
> value details into the agent transcript. That's an intentional tradeoff for an
> example bounded by the read-only role; sanitize errors in stricter environments.

Results are capped at `POSTGRES_MAX_ROWS` (default 100, hard cap 1000) and run
under a `statement_timeout`, so the worker is meant for answering questions
inline, not bulk export.

## Set up Postgres

Create a dedicated read-only user scoped to just the data the agent should see.
Run this in `psql` or your preferred client, replacing `mydb` and schema names
as needed:

```sql
CREATE ROLE notion_agent_readonly;

-- Grant connection and schema usage
GRANT CONNECT ON DATABASE mydb TO notion_agent_readonly;
GRANT USAGE ON SCHEMA public TO notion_agent_readonly;

-- Grant SELECT on existing and future tables
GRANT SELECT ON ALL TABLES IN SCHEMA public TO notion_agent_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO notion_agent_readonly;

-- Create the service user
CREATE USER notion_agent_svc WITH PASSWORD 'changeme';
GRANT notion_agent_readonly TO notion_agent_svc;
```

That role, not the SQL check in the code, is what actually keeps the agent from
writing.

## Setup

### 1. Install the Notion Workers CLI

```zsh
npm install -g @notionhq/workers-cli
```

### 2. Clone and install

```zsh
git clone https://github.com/makenotion/notion-cookbook.git
cd notion-cookbook/examples/workers/tools/postgres-query
npm install
```

### 3. Connect to your workspace

```zsh
ntn login
```

### 4. Deploy

```zsh
ntn workers deploy --name postgres-query
```

### 5. Set the connection secrets

These are worker secrets and never live in the repo (`.env` and `workers.json`
are gitignored). Use either `DATABASE_URL` or the discrete `PG*` vars:

```zsh
# Option A: full connection string
ntn workers env set DATABASE_URL=postgres://notion_agent_svc:changeme@host:5432/mydb

# Option B: discrete vars
ntn workers env set PGHOST=host
ntn workers env set PGPORT=5432
ntn workers env set PGDATABASE=mydb
ntn workers env set PGUSER=notion_agent_svc
ntn workers env set PGPASSWORD=changeme
ntn workers env set PGSSLMODE=require
```

Optional tuning:

```zsh
# Default row cap for the query tool (default 100, capped at 1000)
ntn workers env set POSTGRES_MAX_ROWS=100
# Statement timeout in seconds (default 60, capped at 300)
ntn workers env set POSTGRES_QUERY_TIMEOUT_SECONDS=60
```

## Connect it to an agent

Once deployed, add the worker to a custom agent under
**Tools and access > Add connection**. The agent can then call `listTables`,
`describeTable`, and `query`.

A prompt like:

> What were total orders by month this year? Find the right table first.

usually has the agent list tables, describe the likely one, then run a query
and summarize what comes back.

## Local testing

Copy `.env.example` to `.env`, fill in your values, and run a tool without
deploying:

```zsh
ntn workers exec listTables --local -d '{}'
ntn workers exec describeTable --local -d '{"table": "orders"}'
ntn workers exec query --local \
  -d '{"sql": "SELECT current_date AS ds", "maxRows": 10}'
```

Run the offline test suite (no database required):

```zsh
npm test
```

## Learn more

- [Notion Workers documentation](https://developers.notion.com/docs/workers)
- [Postgres role system](https://www.postgresql.org/docs/current/user-manag.html)
- [Contribute to this cookbook](../../../../CONTRIBUTING.md)
