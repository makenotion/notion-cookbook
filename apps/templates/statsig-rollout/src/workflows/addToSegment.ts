import { access, events, workflow, type WorkflowContext } from "@notionhq/apps"
import { j } from "@notionhq/apps/schema-builder"
import { FatalError } from "@notionhq/apps/workflow"

import { rollout, STATUS, type Status } from "./lib/notion.js"
import { addIdsToSegment, StatsigError } from "./lib/statsig.js"
import { normalizeUuid, pageIdFromUrl } from "./lib/uuid.js"

const API_KEY_ENV = "STATSIG_CONSOLE_API_KEY"
const SEGMENT_ENV = "STATSIG_SEGMENT_ID"
const MAX_ATTEMPTS = 3

export default workflow({
  name: "Add to segment",
  description:
    "Validates an ID added to Rollout and adds it to a Statsig ID List segment.",
  triggers: [
    // For debugging: runs the validation and Statsig call without touching
    // the database, to separate trigger problems from logic problems.
    events.manual({
      inputSchema: j.object({
        id: j.string().describe("ID to add to the segment"),
      }),
    }),
    events.notionPageCreated({ dataSource: rollout.dataSource }),
    events.notionPageUpdated({
      dataSource: rollout.dataSource,
      properties: [
        rollout.dataSource.properties.ID,
        rollout.dataSource.properties.Status,
      ],
    }),
  ],
  access: { spaces: access.edit(rollout.dataSource) },
  handler: async (event, context) => {
    if (event.type === "workflow.manual") {
      const id = normalizeUuid(event.input.id)
      if (!id) {
        throw new FatalError(`"${event.input.id}" is not a UUID`)
      }
      const result = await context.step(
        "Add to Statsig segment",
        { timeoutMs: 60_000, retry: { maxAttempts: 1 } },
        ({ signal }) => addWithRetry(id, signal)
      )
      if (!result.ok) {
        throw new FatalError(result.error)
      }
      console.log(`Added ${id} to ${process.env[SEGMENT_ENV]}`)
      return
    }

    const pageId = pageIdFromEvent(event)
    if (!pageId) {
      throw new FatalError(
        "Could not determine the page ID from the trigger event"
      )
    }

    const row = await context.step("Read row", async () => {
      const page = await context.notion.pages.retrieve({ page_id: pageId })
      const properties = "properties" in page ? page.properties : {}
      return {
        id: readTitle(properties.ID),
        status: readStatus(properties.Status),
      }
    })

    const rawId = row.id.trim()
    // Only pending rows run: new rows, or rows set back to pending to retry.
    // The workflow never writes pending, so the update events fired by its own
    // status writes are skipped. Rows with no ID yet stay pending until the ID
    // is typed in.
    if (!rawId || (row.status !== null && row.status !== STATUS.pending)) {
      return
    }

    const id = normalizeUuid(rawId)
    if (!id) {
      await context.step("Mark invalid", () =>
        setStatus(
          context.notion,
          pageId,
          STATUS.invalid,
          `"${rawId}" is not a UUID`
        )
      )
      return
    }

    await context.step("Mark adding", () =>
      setStatus(context.notion, pageId, STATUS.adding, "")
    )

    const result = await context.step(
      "Add to Statsig segment",
      { timeoutMs: 60_000, retry: { maxAttempts: 1 } },
      ({ signal }) => addWithRetry(id, signal)
    )

    await context.step("Record result", () =>
      result.ok
        ? setStatus(context.notion, pageId, STATUS.success, "")
        : setStatus(context.notion, pageId, STATUS.fail, result.error)
    )
  },
})

type AddResult = { ok: true } | { ok: false; error: string }

async function addWithRetry(
  id: string,
  signal: AbortSignal
): Promise<AddResult> {
  const apiKey = process.env[API_KEY_ENV]
  const segmentId = process.env[SEGMENT_ENV]
  if (!apiKey || !segmentId) {
    return {
      ok: false,
      error: `${!apiKey ? API_KEY_ENV : SEGMENT_ENV} is not set`,
    }
  }
  let lastError = ""
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await addIdsToSegment(apiKey, segmentId, [id], signal)
      return { ok: true }
    } catch (error) {
      signal.throwIfAborted()
      lastError = error instanceof Error ? error.message : String(error)
      const retryable = !(error instanceof StatsigError) || error.retryable
      if (!retryable || attempt === MAX_ATTEMPTS) {
        break
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 1_000 * 4 ** (attempt - 1))
      )
    }
  }
  return { ok: false, error: lastError }
}

async function setStatus(
  notion: WorkflowContext["notion"],
  pageId: string,
  status: Status,
  error: string
): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      Status: { status: { name: status } },
      Error: {
        rich_text: error
          ? [{ type: "text", text: { content: error.slice(0, 2000) } }]
          : [],
      },
    },
  })
}

function pageIdFromEvent(event: {
  url: string | null
  [key: string]: unknown
}): string | null {
  const page = event.page as { id?: unknown } | undefined
  if (typeof page?.id === "string") {
    return page.id
  }
  return pageIdFromUrl(event.url)
}

function readTitle(property: unknown): string {
  const title =
    (property as { title?: { plain_text?: string }[] } | undefined)?.title ?? []
  return title.map((part) => part.plain_text ?? "").join("")
}

function readStatus(property: unknown): string | null {
  return (
    (property as { status?: { name?: string } | null } | undefined)?.status
      ?.name ?? null
  )
}
