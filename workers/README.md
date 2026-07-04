# Notion Worker examples

[Notion Workers](https://developers.notion.com/docs/workers) are server-side extensions deployed to Notion. Each direct child of this directory is an independently executable and deployable Worker.

There are 3 different type of Worker capabilties:

- A **sync** imports external records into a managed Notion database on a
  schedule or on demand.
- An **agent tool** lets a Notion Agent query context or execute a repeatable API workflow
  in one step.
- A **webhook** handles events sent by another app to trigger workflows in Notion or other places.

For self-hosted integrations built directly with the Notion API, see the [API examples](../examples/).

## Syncs

| Worker                                           | What it maintains                                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| [DuckDB sync](duckdb-sync/)                      | A self-contained managed database populated from seeded, in-memory DuckDB data; useful for learning the sync contract.               |
| [GitHub stars sync](github-stars-sync/)          | The authenticated user's starred repositories as a current research and evaluation library.                                          |
| [GitHub sync](github-sync/)                      | Issues, all pull requests, and open pull requests with review and CI status.                                                         |
| [HubSpot sync](hubspot-sync/)                    | CRM contacts, deals, and companies.                                                                                                  |
| [Intercom sync](intercom-sync/)                  | Companies, contacts, conversations, and tickets linked for support operations and customer context.                                  |
| [Jira sync](jira-sync/)                          | Jira Cloud issues, current sprints, sprint analytics, and projects.                                                                  |
| [Linear sync](linear-sync/)                      | Linear projects, issues, and initiatives.                                                                                            |
| [PagerDuty sync](pagerduty-sync/)                | Active and recent incidents linked to service readiness, current on-call coverage, ownership, and routing context.                   |
| [Readwise and Reader sync](readwise-sync/)       | A Reader library and Readwise highlights linked into a durable archive that preserves Notion pages.                                  |
| [Salesforce sync](salesforce-sync/)              | Salesforce accounts and opportunities, with related account context.                                                                 |
| [Sentry sync](sentry-sync/)                      | Issue triage, project reliability trends, and recent release health for cross-functional follow-up.                                  |
| [Snowflake sync](snowflake-sync/)                | Rows returned by a configurable Snowflake query.                                                                                     |
| [Todoist sync](todoist-sync/)                    | Open tasks and project summaries with recent completion context.                                                                     |
| [Workday employee directory sync](workday-sync/) | A daily employee-facing directory of people, work email, Notion People references, supervisory organizations, and manager relations. |
| [Zendesk sync](zendesk-sync/)                    | Related tickets, organizations, users, CSAT responses, metrics, and SLA policies with manual repair sweeps.                          |

## Agent tools

| Worker                                                                    | What an agent can do                                                               |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Airflow](airflow/)                                                       | Inspect DAGs, runs, tasks, logs, and service health through the Airflow REST API.  |
| [Chart generator](chart-generator/)                                       | Render a Vega-Lite chart, upload the PNG, and insert it into a Notion page.        |
| [CloudWatch Logs](cloudwatch-logs/)                                       | Find log groups and streams and read AWS CloudWatch log events.                    |
| [DuckDB query](duckdb-query/)                                             | Query a seeded, in-memory DuckDB database with read-only SQL; no secrets required. |
| [Postgres query](postgres-query/)                                         | Discover tables and query PostgreSQL with guarded, read-only SQL.                  |
| [PowerPoint creator](powerpoint-creator/)                                 | Turn a Notion page into PowerPoint slides and attach the generated `.pptx` file.   |
| [Snowflake query](snowflake-query/)                                       | Discover tables and query Snowflake with guarded, read-only SQL.                   |
| [SQLite query](sqlite-query/)                                             | Query a seeded, in-memory SQLite database; no secrets required.                    |
| [Vercel production deployment tools](vercel-production-deployment-tools/) | Inspect, promote, or roll back one Vercel project with live release checks.        |

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
