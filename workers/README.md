# Notion Worker examples

Runnable [Notion Workers](https://developers.notion.com/docs/workers) written in
TypeScript. Each direct child of this directory is an independently installable
and deployable project.

- A **sync** imports external records into a managed Notion database on a
  schedule or on demand.
- A **tool** gives a Notion agent a callable capability.
- A **webhook** verifies and handles events sent by another service.

For local programs built directly on the Notion API, see the
[API examples](../examples/).

## Syncs

| Worker                              | What it maintains                                                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [DuckDB sync](duckdb-sync/)         | A self-contained managed database populated from seeded, in-memory DuckDB data; useful for learning the sync contract. |
| [GitHub sync](github-sync/)         | Issues, all pull requests, and open pull requests with review and CI status.                                           |
| [HubSpot sync](hubspot-sync/)       | CRM contacts, deals, and companies.                                                                                    |
| [Jira sync](jira-sync/)             | Jira Cloud issues, current sprints, sprint analytics, and projects.                                                    |
| [Linear sync](linear-sync/)         | Linear projects, issues, and initiatives.                                                                              |
| [Salesforce sync](salesforce-sync/) | Salesforce accounts and opportunities, with related account context.                                                   |
| [Snowflake sync](snowflake-sync/)   | Rows returned by a configurable Snowflake query.                                                                       |
| [Zendesk sync](zendesk-sync/)       | Tickets, organizations, users, CSAT responses, ticket metrics, and SLA policies.                                       |

## Agent tools

| Worker                                    | What an agent can do                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| [Airflow](airflow/)                       | Inspect DAGs, runs, tasks, logs, and service health through the Airflow REST API.  |
| [Chart generator](chart-generator/)       | Render a Vega-Lite chart, upload the PNG, and insert it into a Notion page.        |
| [CloudWatch Logs](cloudwatch-logs/)       | Find log groups and streams and read AWS CloudWatch log events.                    |
| [DuckDB query](duckdb-query/)             | Query a seeded, in-memory DuckDB database with read-only SQL; no secrets required. |
| [Postgres query](postgres-query/)         | Discover tables and query PostgreSQL with guarded, read-only SQL.                  |
| [PowerPoint creator](powerpoint-creator/) | Turn a Notion page into PowerPoint slides and attach the generated `.pptx` file.   |
| [Snowflake query](snowflake-query/)       | Discover tables and query Snowflake with guarded, read-only SQL.                   |
| [SQLite query](sqlite-query/)             | Query a seeded, in-memory SQLite database; no secrets required.                    |

## Webhooks

| Worker                              | What it handles                                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [Zendesk webhook](zendesk-webhook/) | Verifies signed ticket events, enriches them with comments, and upserts them into a Notion database. |

## Quickstart

The DuckDB query Worker is a useful first deployment because it has offline
tests and requires no external credentials:

```sh
npm install --global ntn
cd workers/duckdb-query
npm install
npm run check
npm test
ntn login
ntn workers deploy --name duckdb-query
```

After deployment, add it to a custom agent under **Tools and access > Add
connection**. Its in-memory data is reseeded whenever the Worker starts.

## Working with another Worker

1. Read the project's README and `src/index.ts`.
2. Install its dependencies locally with `npm install`.
3. Run `npm run check`, `npm test`, and `npm run build` when those scripts are
   present.
4. Install and authenticate the Workers CLI with `ntn login`.
5. Deploy using the exact command in the project's README.
6. Set external-service credentials with `ntn workers env set`; never commit
   secrets or generated local Worker state.

Workers require Node.js 22 and npm 10.9.2 or newer. Some tests are entirely
offline; live verification and deployment may still require service accounts.

## Naming and discovery

Project names put the integration or domain first and the capability second:
`linear-sync`, `snowflake-query`, and `zendesk-webhook`. This groups everything
supported for one integration when the directory is sorted. The root
[`catalog.json`](../catalog.json) records the formal Worker kind, integration,
entrypoint, and supported commands for reliable agent discovery.

## Contributing

New Workers belong directly under `workers/<integration>-<capability>/`. Follow
the Worker project contract and validation steps in
[`CONTRIBUTING.md`](../CONTRIBUTING.md).
