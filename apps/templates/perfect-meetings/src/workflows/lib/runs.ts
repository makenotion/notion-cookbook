import { asPage, prop, read, type Notion } from "../../lib/props.js"
import { RUN_STATUS, RUN_TRIGGER } from "../../notion.js"

export type RunTrigger = (typeof RUN_TRIGGER)[keyof typeof RUN_TRIGGER]
type RunResult = typeof RUN_STATUS.success | typeof RUN_STATUS.failed

const MAX_ERROR = 2000

/**
 * Whether a new Workflow runs row is a person asking for a run. Rows the ingest
 * logs are created with a workflow Trigger; reacting to them would run every
 * ingest twice.
 */
export async function isRunRequest(
  notion: Notion,
  pageId: string
): Promise<boolean> {
  const page = asPage(await notion.pages.retrieve({ page_id: pageId }))
  const trigger = read.select(page.properties, "Trigger")
  return trigger === null || trigger === RUN_TRIGGER.runNow
}

/**
 * Marks a run as started: fills in the requested row, or logs a new row for
 * every other trigger. Returns the row's page ID.
 */
export async function startRun(
  notion: Notion,
  runsId: string,
  run: {
    requestPageId: string | null
    trigger: RunTrigger
    runId: string
    startedAt: string
  }
): Promise<string> {
  const properties = {
    Started: prop.date(run.startedAt),
    Status: prop.select(RUN_STATUS.pending),
    Trigger: prop.select(run.trigger),
    "Run ID": prop.text(run.runId),
  }
  if (run.requestPageId) {
    await notion.pages.update({ page_id: run.requestPageId, properties })
    return run.requestPageId
  }
  const page = await notion.pages.create({
    parent: { data_source_id: runsId },
    properties: { Name: prop.title(run.trigger), ...properties },
  })
  return page.id
}

/** Records how a run ended. */
export async function finishRun(
  notion: Notion,
  pageId: string,
  status: RunResult,
  error = ""
): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      Finished: prop.date(new Date().toISOString()),
      Status: prop.select(status),
      Error: prop.text(error.slice(0, MAX_ERROR)),
    },
  })
}
