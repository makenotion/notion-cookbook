import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"

const worker = new Worker()
export default worker

// Validated lazily so a missing env doesn't prevent capability discovery at require() time.
function getConfig(): { url: string; apiKey: string } {
  const url = process.env.AIRFLOW_URL ?? ""
  const apiKey = process.env.AIRFLOW_API_KEY ?? ""
  if (!url || !apiKey) {
    throw new Error(
      "Missing Airflow configuration. Set AIRFLOW_URL and AIRFLOW_API_KEY."
    )
  }
  // Surface a clear config error instead of an opaque fetch failure when the
  // operator sets a malformed base URL (missing scheme, typo, etc.).
  try {
    new URL(url)
  } catch {
    throw new Error(
      `AIRFLOW_URL is not a valid URL: "${url}". Use a full base URL like https://airflow.example.com.`
    )
  }
  return { url, apiKey }
}

// Clamp agent-supplied pagination so a negative offset, limit=0, or an absurd
// limit can't produce surprising results; mirrors the listDags bounds.
function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.floor(limit), 1), 200)
}

function clampOffset(offset: number): number {
  const n = Math.floor(offset)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// Shared HTTP client for the Airflow REST API. Throws on non-2xx responses.
async function airflowRequest(
  path: string,
  options: { method?: string; body?: string } = {}
): Promise<any> {
  const { url, apiKey } = getConfig()
  const method = options.method ?? "GET"
  const fullUrl = `${url}/api/v1${path}`

  const res = await fetch(fullUrl, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(options.body ? { body: options.body } : {}),
  })

  if (!res.ok)
    throw new Error(`Airflow API error: ${res.status} ${res.statusText}`)
  return res.json()
}

function airflowGet(path: string) {
  return airflowRequest(path)
}

// Slim a DAG object down to the fields useful for browsing; truncate long descriptions.
const DESCRIPTION_MAX = 80

export function slimDag(d: any) {
  return {
    dag_id: d.dag_id,
    is_active: d.is_active,
    is_paused: d.is_paused,
    owners: d.owners,
    tags: (d.tags as { name: string }[]).map((t) => t.name),
    description: d.description
      ? (d.description as string).slice(0, DESCRIPTION_MAX)
      : null,
    has_import_errors: d.has_import_errors,
  }
}

// Logs can be enormous; always return the tail so output stays bounded.
export const MAX_CHARS = 55_000

export function truncateTail(
  content: string,
  max: number
): { content: string; truncated: boolean; total_chars: number } {
  const truncated = content.length > max
  return {
    total_chars: content.length,
    truncated,
    content: truncated ? content.slice(content.length - max) : content,
  }
}

// Hand the agent a readable error instead of throwing, so it can correct itself.
async function safely<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn()
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// Fetches all DAGs internally and returns only aggregated counts (tiny output, always safe).
worker.tool("summarizeDags", {
  title: "Summarize DAGs",
  description:
    "Get a compact summary of all DAGs: total count, active/paused breakdown, and DAG count per owner and tag. Call this before listDags to discover what owners and tags exist, then use listDags with a specific filter to retrieve the actual DAG list.",
  schema: j.object({}),
  execute: () =>
    safely(async () => {
      const BATCH = 100
      const first = await airflowGet(`/dags?limit=${BATCH}&offset=0`)
      const total: number = first.total_entries
      const dags: any[] = [...first.dags]

      const batches = Math.ceil((total - dags.length) / BATCH)
      for (let i = 0; i < batches; i++) {
        const page = await airflowGet(
          `/dags?limit=${BATCH}&offset=${(i + 1) * BATCH}`
        )
        dags.push(...page.dags)
      }

      const byOwner: Record<string, number> = {}
      const byTag: Record<string, number> = {}
      let active = 0
      let paused = 0

      for (const d of dags) {
        if (d.is_active && !d.is_paused) active++
        if (d.is_paused) paused++
        for (const owner of d.owners as string[]) {
          byOwner[owner] = (byOwner[owner] ?? 0) + 1
        }
        for (const tag of d.tags as { name: string }[]) {
          byTag[tag.name] = (byTag[tag.name] ?? 0) + 1
        }
      }

      return { total, active, paused, by_owner: byOwner, by_tag: byTag }
    }),
})

// Lists DAGs with explicit pagination. The LLM controls page size; output is bounded.
worker.tool("listDags", {
  title: "List DAGs",
  description:
    "List DAGs in Airflow with pagination. Returns up to `limit` DAGs starting at `offset`. Filter by `tags` (server-side) or `owners` (client-side). Call summarizeDags first to discover available owners and tags. If `has_more` is true, call again with `next_offset` to get the next page.",
  schema: j.object({
    tags: j
      .string()
      .nullable()
      .describe("Filter by tag name. Pass null to return all tags."),
    owners: j
      .string()
      .nullable()
      .describe(
        "Filter by owner name. Client-side filter — combine with a small limit to avoid large fetches."
      ),
    limit: j.number().describe("Max DAGs to return (1–200). Default: 100."),
    offset: j
      .number()
      .describe(
        "Number of DAGs to skip. Use next_offset from the previous response to paginate."
      ),
  }),
  execute: ({ tags, owners, limit, offset }) =>
    safely(async () => {
      const pageSize = Math.min(Math.max(limit, 1), 200)

      if (!owners) {
        // Server-side pagination
        const params = new URLSearchParams({
          limit: String(pageSize),
          offset: String(offset),
        })
        if (tags) params.set("tags", tags)
        const data = await airflowGet(`/dags?${params}`)
        const slim = (data.dags as any[]).map(slimDag)
        const nextOffset = offset + slim.length
        return {
          total_entries: data.total_entries,
          returned: slim.length,
          has_more: nextOffset < data.total_entries,
          next_offset: nextOffset < data.total_entries ? nextOffset : null,
          dags: slim,
        }
      }

      // Client-side owners filter: scan server pages, skip `offset` matches, collect `limit` matches
      const BATCH = 100
      let serverOffset = 0
      let skipped = 0
      let pagesExhausted = false
      const collected: any[] = []

      while (collected.length < pageSize) {
        const params = new URLSearchParams({
          limit: String(BATCH),
          offset: String(serverOffset),
        })
        if (tags) params.set("tags", tags)
        const data = await airflowGet(`/dags?${params}`)
        const page: any[] = data.dags
        if (page.length === 0) {
          pagesExhausted = true
          break
        }

        for (const d of page) {
          if (!(d.owners as string[]).includes(owners)) continue
          if (skipped < offset) {
            skipped++
            continue
          }
          collected.push(slimDag(d))
          if (collected.length === pageSize) break
        }

        serverOffset += page.length
        if (serverOffset >= data.total_entries) {
          pagesExhausted = true
          break
        }
      }

      const hasMore = !pagesExhausted && collected.length === pageSize
      return {
        total_entries: null,
        returned: collected.length,
        has_more: hasMore,
        next_offset: hasMore ? offset + collected.length : null,
        dags: collected,
      }
    }),
})

// Returns full metadata for a single DAG including schedule, tags, and file location.
worker.tool("getDag", {
  title: "Get DAG",
  description: "Get details about a specific DAG.",
  schema: j.object({
    dag_id: j.string().describe("The DAG ID."),
  }),
  execute: ({ dag_id }) =>
    safely(() => airflowGet(`/dags/${encodeURIComponent(dag_id)}`)),
})

// Returns the run history for a DAG (state, start/end times, run type).
worker.tool("listDagRuns", {
  title: "List DAG Runs",
  description:
    "Get run history for a specific DAG. Use limit and offset to paginate through large run histories. Optionally filter by state (success, failed, running, queued).",
  schema: j.object({
    dag_id: j.string().describe("The DAG ID."),
    limit: j
      .number()
      .describe("Max number of runs to return. Defaults to 100."),
    offset: j.number().describe("Number of runs to skip. Use for pagination."),
    state: j
      .string()
      .nullable()
      .describe(
        "Filter by run state (success, failed, running, queued). Pass null to return all states."
      ),
  }),
  execute: ({ dag_id, limit, offset, state }) =>
    safely(() => {
      const params = new URLSearchParams({
        limit: String(clampLimit(limit)),
        offset: String(clampOffset(offset)),
      })
      if (state) params.set("state", state)
      return airflowGet(`/dags/${encodeURIComponent(dag_id)}/dagRuns?${params}`)
    }),
})

// Returns the state and timing of a single DAG run.
worker.tool("getDagRun", {
  title: "Get DAG Run",
  description: "Get the status of a specific DAG run.",
  schema: j.object({
    dag_id: j.string().describe("The DAG ID."),
    dag_run_id: j.string().describe("The DAG run ID."),
  }),
  execute: ({ dag_id, dag_run_id }) =>
    safely(() =>
      airflowGet(
        `/dags/${encodeURIComponent(dag_id)}/dagRuns/${encodeURIComponent(dag_run_id)}`
      )
    ),
})

// Returns the static task definitions in a DAG (not run-specific).
worker.tool("listTasks", {
  title: "List Tasks",
  description:
    "List all tasks defined in a DAG, showing the structure of the pipeline.",
  schema: j.object({
    dag_id: j.string().describe("The DAG ID."),
  }),
  execute: ({ dag_id }) =>
    safely(() => airflowGet(`/dags/${encodeURIComponent(dag_id)}/tasks`)),
})

// Returns per-task state and timing for a specific DAG run.
worker.tool("listTaskInstances", {
  title: "List Task Instances",
  description:
    "Get task-level status for a specific DAG run. Use limit and offset to paginate through runs with more than 100 tasks.",
  schema: j.object({
    dag_id: j.string().describe("The DAG ID."),
    dag_run_id: j.string().describe("The DAG run ID."),
    limit: j
      .number()
      .describe("Max number of task instances to return. Default: 100."),
    offset: j
      .number()
      .describe(
        "Number of task instances to skip. Default: 0. Use for pagination."
      ),
  }),
  execute: ({ dag_id, dag_run_id, limit, offset }) =>
    safely(() => {
      const params = new URLSearchParams({
        limit: String(clampLimit(limit)),
        offset: String(clampOffset(offset)),
      })
      return airflowGet(
        `/dags/${encodeURIComponent(dag_id)}/dagRuns/${encodeURIComponent(dag_run_id)}/taskInstances?${params}`
      )
    }),
})

// Fetches stdout/stderr logs for a specific task attempt. Use try number 1 for the first attempt.
// Always returns the last MAX_CHARS characters to keep output bounded and behavior deterministic.
worker.tool("getTaskLogs", {
  title: "Get Task Logs",
  description: `Fetch logs for a specific task instance. Always returns the last ${MAX_CHARS} characters of the log.`,
  schema: j.object({
    dag_id: j.string().describe("The DAG ID."),
    dag_run_id: j.string().describe("The DAG run ID."),
    task_id: j.string().describe("The task ID."),
    task_try_number: j
      .number()
      .describe("The try number (use 1 for the first attempt)."),
  }),
  execute: ({ dag_id, dag_run_id, task_id, task_try_number }) =>
    safely(async () => {
      const data = await airflowGet(
        `/dags/${encodeURIComponent(dag_id)}/dagRuns/${encodeURIComponent(dag_run_id)}/taskInstances/${encodeURIComponent(task_id)}/logs/${task_try_number}`
      )
      const content: string =
        typeof data === "string" ? data : (data.content ?? JSON.stringify(data))
      return truncateTail(content, MAX_CHARS)
    }),
})

// Returns the health status of the scheduler, metadatabase, and triggerer.
worker.tool("healthCheck", {
  title: "Health Check",
  description:
    "Check the health status of the Airflow instance, including the scheduler and metadatabase.",
  schema: j.object({}),
  execute: () => safely(() => airflowGet("/health")),
})
