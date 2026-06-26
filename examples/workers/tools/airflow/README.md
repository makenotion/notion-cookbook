# Worker tool: Airflow

A Notion worker that lets a custom agent inspect and monitor your Apache Airflow instance. It registers nine tools covering DAG discovery, run history, task status, log retrieval, and health — so the agent can answer questions like "why did this pipeline fail last night?" without anyone navigating the Airflow UI.

## How it works

The worker calls the [Airflow stable REST API](https://airflow.apache.org/docs/apache-airflow/stable/stable-rest-api-ref.html) (v1) using a Bearer token. No Airflow plugin or database access is required — only the REST API endpoint and an API key. Results are returned as structured JSON and summarized by the agent inline in the conversation.

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

## Setup

### 1. Install the Notion Workers CLI

```zsh
npm install -g @notionhq/workers-cli
```

### 2. Clone and install

```zsh
git clone https://github.com/makenotion/notion-cookbook.git
cd notion-cookbook/examples/workers/tools/airflow
npm install
```

### 3. Connect to your workspace

```zsh
ntn login
```

### 4. Deploy

```zsh
ntn workers deploy --name airflow
```

### 5. Set the connection secrets

These are worker secrets and never live in the repo (`.env` and `workers.json` are gitignored):

```zsh
ntn workers env set AIRFLOW_URL=https://airflow.example.com
ntn workers env set AIRFLOW_API_KEY=your_api_key_here
```

### 6. Connect it to an agent

Once deployed, add the worker to a custom agent under **Tools and access > Add connection**. The agent can then call any of the nine tools.

## Environment variables

| Variable          | Required | Description                                                                                              |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `AIRFLOW_URL`     | Yes      | Base URL of your Airflow instance, without the `/api/v1` suffix. Example: `https://airflow.example.com`. |
| `AIRFLOW_API_KEY` | Yes      | Bearer token for the Airflow REST API.                                                                   |

> **Note on auth:** This worker uses Bearer token authentication, which is the default for Airflow 2.x with the stable REST API enabled. If your deployment uses HTTP Basic auth instead, change the `Authorization` header in `src/index.ts` from `Bearer ${apiKey}` to `Basic ${Buffer.from(apiKey).toString("base64")}` and store the credentials as `user:password` in `AIRFLOW_API_KEY`.

## Local testing

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
- [Airflow stable REST API reference](https://airflow.apache.org/docs/apache-airflow/stable/stable-rest-api-ref.html)
- [Contribute to this cookbook](../../../../CONTRIBUTING.md)
