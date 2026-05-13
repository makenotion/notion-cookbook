# Worker Tool: Snowflake Query

A Notion agent tool that runs read-only SQL queries against a Snowflake warehouse and returns structured results. Auth is key-pair JWT against the Snowflake SQL REST API — no native Snowflake SDK is needed inside the worker sandbox.

## Prerequisites

- A Notion workspace where you can install workers.
- A Snowflake account with a user you can authenticate as.
- The Snowflake `ACCOUNTADMIN` role (or equivalent) to upload an RSA public key to your user.
- A **read-only** Snowflake role for the tool to assume (recommended — limits blast radius if the agent is asked to run something unexpected).
- Node.js ≥ 22 and the [`ntn` CLI](https://developers.notion.com/workers/get-started/quickstart) installed.

## Step 1 — Generate an RSA key pair

```zsh
# Private key (used by the worker)
openssl genrsa -out snowflake_rsa.pem 2048

# Public key (uploaded to Snowflake)
openssl rsa -in snowflake_rsa.pem -pubout -out snowflake_rsa.pub
```

Keep `snowflake_rsa.pem` somewhere safe — anyone with it can authenticate as your Snowflake user.

## Step 2 — Register the public key with your Snowflake user

In a Snowflake worksheet, strip the PEM header/footer from `snowflake_rsa.pub` and run:

```sql
ALTER USER <your-user> SET RSA_PUBLIC_KEY = '<base64-body-of-public-key>';
```

Verify:

```sql
DESC USER <your-user>;
-- Look for RSA_PUBLIC_KEY_FP and RSA_PUBLIC_KEY in the output.
```

## Step 3 — Clone and install

```zsh
git clone https://github.com/makenotion/notion-cookbook.git
cd notion-cookbook/examples/workers/tools/snowflake-query
npm install
ntn login
```

## Step 4 — Store the credentials

```zsh
ntn workers env set SNOWFLAKE_ACCOUNT=<account-locator>     # e.g. xy12345.us-east-1
ntn workers env set SNOWFLAKE_USER=<your-user>
ntn workers env set SNOWFLAKE_PRIVATE_KEY="$(cat snowflake_rsa.pem)"
ntn workers env set SNOWFLAKE_WAREHOUSE=<warehouse>
ntn workers env set SNOWFLAKE_ROLE=<read-only-role>

# Optional — pin the default database/schema so queries don't need fully
# qualified names.
ntn workers env set SNOWFLAKE_DATABASE=<database>
ntn workers env set SNOWFLAKE_SCHEMA=<schema>
```

Note the `"$(cat ...)"` wrapping for the private key — `ntn workers env set` accepts multi-line values when quoted this way.

## Step 5 — Deploy

```zsh
ntn workers deploy --name snowflake-query
```

## Step 6 — Verify it works

Hit the tool locally before connecting it to an agent:

```zsh
ntn workers exec runQuery --local -d '{"query":"SELECT CURRENT_USER(), CURRENT_ROLE(), CURRENT_WAREHOUSE()"}'
```

You should see `columns`, `rows`, `rowCount: 1`, and `truncated: false`. If you do, connect the worker to a custom agent (**Tools and access → Add connection**) and ask it something like:

> "Run a query in Snowflake to count how many rows are in `my_table`."

## How the code is organized

- `src/index.ts` — Worker entry. Registers one tool with a `j.object` input schema (`query`, `rowLimit`) and a structured output schema. `hints: { readOnlyHint: true }` lets the agent invoke the tool without confirmation.
- `src/snowflake.ts` — All of the integration logic: JWT minting with `node:crypto`, the SQL REST API call, and the query safety checks (`SELECT`/`WITH` only, no semicolons, wrapping LIMIT).
- `src/types.ts` — `SfStatementResponse` (the Snowflake API shape) and `QueryResult` (what we hand back to the agent).

The JWT issuer string follows Snowflake's required format: `<ACCOUNT>.<USER>.SHA256:<public-key-fingerprint>`. The fingerprint is derived from the private key on every invocation, so you only need to store one secret.

## Customizing

- **Allow more query types** — `assertReadOnly` in `snowflake.ts` enforces `SELECT`/`WITH` only. Extend the regex (e.g. add `show|describe|explain`) if you want more shapes.
- **Bump the row cap** — change the `cap` constant in `snowflake.ts`. Watch response sizes; very large results inflate the agent's context.
- **Bypass the LIMIT wrap** — useful if you want the agent to control pagination via `OFFSET`. Remove the `SELECT * FROM (...) LIMIT N` wrap in `runQuery` and trust the user query.

## Troubleshooting

- **`JWT token is invalid`** — the user/account identifier in the JWT `iss` must match what Snowflake stores. Confirm `SNOWFLAKE_USER` matches `DESC USER`'s output (case-insensitive on Snowflake's side, but we upper-case it for safety).
- **`Authentication token has expired`** — clock skew between Notion and Snowflake. The worker mints a fresh JWT per call, so this should self-resolve next request.
- **`Object 'YOUR_TABLE' does not exist`** — make sure `SNOWFLAKE_ROLE` has `USAGE` on the schema and `SELECT` on the table.
- **`Query took longer than the synchronous timeout`** — the tool only handles synchronous responses. Optimize the query (add a `WHERE`, pre-aggregate) or use Snowflake's async API for long-running analytics.

## Learn more

- [Notion Workers documentation](https://developers.notion.com/workers/get-started/overview)
- [Tools guide](https://developers.notion.com/workers/guides/tools)
- [Snowflake SQL REST API](https://docs.snowflake.com/en/developer-guide/sql-api/intro)
- [Key-pair authentication](https://docs.snowflake.com/en/user-guide/key-pair-auth)
- [Contribute to this cookbook](../../../../CONTRIBUTING.md)
