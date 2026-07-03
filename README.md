# Notion cookbook

Working examples, guides, and agent skills for building with the Notion API
and [Notion Workers](https://developers.notion.com/docs/workers). Every example
is self-contained: choose a task, open its README, and run it from its own
directory.

## What do you want to build?

- **Learn the Notion API:** start with
  [Introduction to the Notion API](examples/intro-to-notion-api/), then explore
  [block text parsing](examples/parse-text-from-any-block-type/) or
  [large data source queries](examples/query-large-data-sources/).
- **Build an API integration:** create a
  [web form](examples/web-form-with-express/), connect
  [GitHub issues](examples/notion-github-sync/), or send
  [email notifications](examples/database-email-update/).
- **Bring external data into Notion:** use a Worker sync for
  [GitHub](workers/github-sync/), [HubSpot](workers/hubspot-sync/),
  [Intercom](workers/intercom-sync/), [Jira](workers/jira-sync/),
  [Linear](workers/linear-sync/), [PagerDuty](workers/pagerduty-sync/),
  [Salesforce](workers/salesforce-sync/), [Sentry](workers/sentry-sync/),
  [Snowflake](workers/snowflake-sync/), or [Zendesk](workers/zendesk-sync/).
- **Give a Notion Agent a reliable new capability:** execute a repeatable API
  workflow in one tool call, or connect to [Airflow](workers/airflow/),
  [CloudWatch Logs](workers/cloudwatch-logs/),
  [Postgres](workers/postgres-query/), and more.
- **React to external events:** receive and verify
  [Zendesk webhooks](workers/zendesk-webhook/).

## Quickstarts

### Using this cookbook with a coding agent

Tell the agent the outcome or integration you need, then point it to:

- [`catalog.json`](catalog.json), the machine-readable index of every runnable
  project and its supported commands.
- [`AGENTS.md`](AGENTS.md), the canonical instructions for finding, running,
  adapting, adding, and validating recipes.
- The selected project's README and entrypoint, which are authoritative for its
  setup and implementation.

For example: "Use `catalog.json` to find the Linear sync recipe. Explain its
data flow, adapt it to include issue labels, and run its offline checks."

### Run an API example

The introductory example is the best first project. Create a
[Notion integration](https://www.notion.com/my-integrations), share a test page
with it, then:

```sh
git clone https://github.com/makenotion/notion-cookbook.git
cd notion-cookbook/examples/intro-to-notion-api
npm install
cp .env.example .env
# Add NOTION_API_KEY and NOTION_PAGE_ID to .env
npm run basic:1
```

Other API examples use different scripts and may require additional services.
Use the command in the selected example's README rather than assuming
`npm start`.

### Deploy a Worker

The DuckDB query Worker is self-contained and needs no secrets:

```sh
npm install --global ntn
git clone https://github.com/makenotion/notion-cookbook.git
cd notion-cookbook/workers/duckdb-query
npm install
npm run check
npm test
ntn login
ntn workers deploy --name duckdb-query
```

After deployment, add the Worker to a custom agent under **Tools and access >
Add connection**. Other Workers may need service credentials or database
configuration; follow their READMEs.

## API examples

These examples use the official JavaScript SDK and run locally with Node.js.
See the [API examples guide](examples/) for shared setup information.

| Task                                                         | Example                                                                    | Integrations         |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- | -------------------- |
| Learn blocks, pages, databases, queries, and file uploads    | [Introduction to the Notion API](examples/intro-to-notion-api/)            | Notion API           |
| Send an email when a database status changes                 | [Database email update](examples/database-email-update/)                   | Notion API, SendGrid |
| Fill a database with correctly typed sample rows             | [Generate random data](examples/generate-random-data/)                     | Notion API           |
| Copy GitHub issues into a Notion database                    | [Notion–GitHub issue sync](examples/notion-github-sync/)                   | Notion API, GitHub   |
| Update Notion tasks when linked pull requests close or merge | [Notion task–GitHub PR sync](examples/notion-task-github-pr-sync/)         | Notion API, GitHub   |
| Extract plain text from Notion blocks                        | [Parse text from any block type](examples/parse-text-from-any-block-type/) | Notion API           |
| Read beyond the 10,000-row query limit                       | [Query large data sources](examples/query-large-data-sources/)             | Notion API           |
| Create databases, pages, blocks, and comments from a web UI  | [Web form with Express](examples/web-form-with-express/)                   | Notion API, Express  |

## Worker examples

Workers are server-side extensions deployed to Notion. A **sync** maintains a
managed Notion database, a **tool** gives a Notion Agent a callable capability,
and a **webhook** handles events from another service. See the complete
[Workers guide](workers/) for setup and deployment.

### Sync external data into Notion

| Task                                                        | Worker                                      | Source     |
| ----------------------------------------------------------- | ------------------------------------------- | ---------- |
| Learn the sync pattern with seeded, in-memory data          | [DuckDB sync](workers/duckdb-sync/)         | DuckDB     |
| Sync issues and pull requests                               | [GitHub sync](workers/github-sync/)         | GitHub     |
| Sync contacts, deals, and companies                         | [HubSpot sync](workers/hubspot-sync/)       | HubSpot    |
| Sync companies, contacts, conversations, and tickets        | [Intercom sync](workers/intercom-sync/)     | Intercom   |
| Sync issues, sprints, analytics, and projects               | [Jira sync](workers/jira-sync/)             | Jira Cloud |
| Sync projects, issues, and initiatives                      | [Linear sync](workers/linear-sync/)         | Linear     |
| Monitor PagerDuty incidents and service readiness in Notion | [PagerDuty sync](workers/pagerduty-sync/)   | PagerDuty  |
| Sync accounts and opportunities                             | [Salesforce sync](workers/salesforce-sync/) | Salesforce |
| Coordinate issue triage, service risk, and rollout health   | [Sentry sync](workers/sentry-sync/)         | Sentry     |
| Sync the result of a warehouse query                        | [Snowflake sync](workers/snowflake-sync/)   | Snowflake  |
| Sync related tickets, users, organizations, and metrics     | [Zendesk sync](workers/zendesk-sync/)       | Zendesk    |

### Add tools to a Notion Agent

| Task                                                | Worker                                            | Integration         |
| --------------------------------------------------- | ------------------------------------------------- | ------------------- |
| Inspect DAGs, runs, tasks, and logs                 | [Airflow](workers/airflow/)                       | Apache Airflow      |
| Render and insert Vega-Lite charts                  | [Chart generator](workers/chart-generator/)       | Vega-Lite           |
| Browse log groups, streams, and events              | [CloudWatch Logs](workers/cloudwatch-logs/)       | AWS CloudWatch Logs |
| Learn the database-query pattern with seeded data   | [DuckDB query](workers/duckdb-query/)             | DuckDB              |
| Query a database with read-only SQL                 | [Postgres query](workers/postgres-query/)         | PostgreSQL          |
| Turn a Notion page into PowerPoint slides (`.pptx`) | [PowerPoint creator](workers/powerpoint-creator/) | Notion, PowerPoint  |
| Query a warehouse with read-only SQL                | [Snowflake query](workers/snowflake-query/)       | Snowflake           |
| Learn the database-query pattern with seeded data   | [SQLite query](workers/sqlite-query/)             | SQLite              |

### Handle webhooks

| Task                                                 | Worker                                      | Integration |
| ---------------------------------------------------- | ------------------------------------------- | ----------- |
| Verify ticket events and upsert tickets and comments | [Zendesk webhook](workers/zendesk-webhook/) | Zendesk     |

## More resources

- [Developer guides](docs/) — including the
  [Notion MCP client integration guide](docs/mcp-client-integration.md)
- [Agent skills](skills/) — reusable workflows for working with Notion
- [Notion developer documentation](https://developers.notion.com)
- [Notion API reference](https://developers.notion.com/reference)
- [Contributing](CONTRIBUTING.md) — add or improve an example, Worker, skill, or
  guide

## Community

- [Notion Developers Slack](https://join.slack.com/t/notiondevs/shared_invite/zt-20b5996xv-DzJdLiympy6jP0GGzu3AMg)
- [Stack Overflow](https://stackoverflow.com/questions/tagged/notion-api)

## License

This project is licensed under the [MIT License](LICENSE).
