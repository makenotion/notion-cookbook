# Workers

This directory contains example [Notion workers](https://developers.notion.com/docs/workers) — server-side code that extends Notion with custom capabilities.

## Syncs

The [syncs](syncs/) directory includes one-way sync examples that bring data from external systems into Notion databases:

- **[salesforce](syncs/salesforce/)**: One-way sync from Salesforce records into a Notion database _(coming soon)_
- **[linear](syncs/linear/)**: One-way sync from Linear issues into a Notion database _(coming soon)_

## Tools

The [tools](tools/) directory includes agent tool examples that extend Notion agents with new capabilities:

- **[airflow](tools/airflow/)**: Query Airflow DAGs, runs, tasks, and logs from a Notion agent
- **[chart-generator](tools/chart-generator/)**: Render a Vega-Lite chart to an image and embed it in a Notion page
- **[cloudwatch-logs](tools/cloudwatch-logs/)**: Query AWS CloudWatch log groups, streams, and events from a Notion agent
- **[duckdb-demo](tools/duckdb-demo/)**: Query a self-contained in-memory DuckDB seeded with sample data — no setup required
- **[postgres-query](tools/postgres-query/)**: Query a PostgreSQL database from a Notion agent and return results
- **[snowflake-query](tools/snowflake-query/)**: Query Snowflake from a Notion agent and return results
- **[spotify-control](tools/spotify-control/)**: Start and control Spotify playback from a Notion agent _(coming soon)_

## Webhooks

The [webhooks](webhooks/) directory includes webhook examples that push events from external systems into Notion in real time:

- **[zendesk](webhooks/zendesk/)**: Verify Zendesk ticket webhooks and upsert them into a Notion database
