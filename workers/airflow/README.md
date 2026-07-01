# Worker tool: Airflow

**TL;DR:** Connect Airflow to a Notion agent so it can inspect DAGs, trace failed runs down to task logs, and check platform health without sending you to the Airflow UI.

## Quickstart

This Worker targets Airflow 2.x's stable `/api/v1` REST API and sends a Bearer
token. Airflow 3's `/api/v2` and other authentication schemes require adapting
the client first.

From the repository root:

```zsh
npm install --global ntn
cd workers/airflow
npm install
ntn login
ntn workers deploy --name airflow
ntn workers env set AIRFLOW_URL=https://airflow.example.com
ntn workers env set AIRFLOW_API_KEY=your_api_key_here
```

In Notion, add the deployed worker to a custom agent under **Tools and access > Add connection**.

## Try asking

- "Why did the latest run of `daily_orders` fail? Check the task logs."
- "Which DAGs are owned by the data platform team, and how have their recent runs performed?"
- "Show me the task statuses and durations for this DAG run."
- "Are the Airflow scheduler and metadatabase healthy?"

## How it works

The worker calls the
[Airflow 2.10 stable REST API](https://airflow.apache.org/docs/apache-airflow/2.10.4/stable-rest-api-ref.html)
using `/api/v1` and a Bearer token. No Airflow plugin or database access is
required. Results are returned as structured JSON and summarized by the agent
inside the conversation.

## Tools

| Tool                | Purpose                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `summarizeDags`     | Count all DAGs and break them down by owner and tag. Call this first to discover what's available. |
| `listDags`          | Page through DAGs with optional tag or owner filter.                                               |
| `getDag`            | Fetch full metadata for a single DAG (schedule, file location, tags).                              |
| `listDagRuns`       | Get run history for a DAG, optionally filtered by state.                                           |
| `getDagRun`         | Get the status and timing of a specific DAG run.                                                   |
| `listTasks`         | List the static task definitions in a DAG (the pipeline structure).                                |
| `listTaskInstances` | Get per-task status and timing for a specific run.                                                 |
| `getTaskLogs`       | Fetch stdout/stderr logs for a task attempt. Returns the last 55,000 characters.                   |
| `healthCheck`       | Check the health of the Airflow scheduler and metadatabase.                                        |

## Environment variables

| Variable          | Required | Description                                                                                              |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `AIRFLOW_URL`     | Yes      | Base URL of your Airflow instance, without the `/api/v1` suffix. Example: `https://airflow.example.com`. |
| `AIRFLOW_API_KEY` | Yes      | Bearer token for the Airflow REST API.                                                                   |

> **Note on auth:** This example always sends
> `Authorization: Bearer <AIRFLOW_API_KEY>`. If your Airflow deployment uses
> Basic auth or another backend, adapt the `Authorization` header in
> `src/index.ts` before deploying.

## Run locally

Copy `.env.example` to `.env`, fill in your values, then run individual tools without deploying:

```zsh
# Offline unit tests (no network, no Airflow needed)
npm test

# Live calls against your Airflow instance
ntn workers exec summarizeDags --local -d '{}'
ntn workers exec listDags --local -d '{"tags": null, "owners": null, "limit": 20, "offset": 0}'
ntn workers exec getTaskLogs --local -d '{"dag_id": "my_dag", "dag_run_id": "scheduled__2024-01-01T00:00:00+00:00", "task_id": "my_task", "task_try_number": 1}'
ntn workers exec healthCheck --local -d '{}'
```

## Learn more

- [Notion Workers documentation](https://developers.notion.com/docs/workers)
- [Airflow 2.10 stable REST API reference](https://airflow.apache.org/docs/apache-airflow/2.10.4/stable-rest-api-ref.html)
- [Contribute to this cookbook](../../CONTRIBUTING.md)
