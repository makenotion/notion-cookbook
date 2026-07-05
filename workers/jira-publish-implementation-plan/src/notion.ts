import { normalizePageId, PlanError } from "./plan.js"
import type { PageSnapshot } from "./types.js"

type JsonRecord = Record<string, unknown>

export type NotionClientLike = {
  pages: {
    retrieve(args: { page_id: string }): Promise<unknown>
  }
}

export class NotionPageError extends Error {
  readonly kind: "conflict" | "unavailable"
  readonly retryable: boolean

  constructor(
    message: string,
    options: { kind: "conflict" | "unavailable"; retryable?: boolean }
  ) {
    super(message)
    this.name = "NotionPageError"
    this.kind = options.kind
    this.retryable = options.retryable ?? false
  }
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

function statusFromError(error: unknown): number | null {
  const value = record(error)?.status
  return typeof value === "number" ? value : null
}

async function withTimeout<T>(
  operation: () => Promise<T>,
  ms: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Notion request timed out")), ms)
  })
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function getPageSnapshot(
  notion: NotionClientLike,
  sourcePageId: string,
  timeoutMs = 8_000
): Promise<PageSnapshot> {
  let expectedId: string
  try {
    expectedId = normalizePageId(sourcePageId)
  } catch (error) {
    if (error instanceof PlanError) {
      throw new NotionPageError(error.message, { kind: "conflict" })
    }
    throw error
  }

  let response: unknown
  try {
    response = await withTimeout(
      () => notion.pages.retrieve({ page_id: expectedId }),
      timeoutMs
    )
  } catch (error) {
    const status = statusFromError(error)
    throw new NotionPageError(
      `Notion could not read the source page${status === null ? "" : ` (HTTP ${status})`}`,
      {
        kind: status === 404 ? "conflict" : "unavailable",
        retryable:
          status === null ||
          status === 408 ||
          status === 429 ||
          status === 529 ||
          (status !== null && status >= 500),
      }
    )
  }

  const page = record(response)
  let observedId: string | null = null
  try {
    observedId = typeof page?.id === "string" ? normalizePageId(page.id) : null
  } catch {
    observedId = null
  }
  const lastEditedTime =
    typeof page?.last_edited_time === "string" ? page.last_edited_time : null
  if (
    observedId !== expectedId ||
    !lastEditedTime ||
    Number.isNaN(Date.parse(lastEditedTime)) ||
    page?.archived === true ||
    page?.in_trash === true
  ) {
    throw new NotionPageError(
      "Notion source page identity, edit time, or availability is invalid",
      { kind: "conflict" }
    )
  }
  const returnedUrl = typeof page?.url === "string" ? page.url : ""
  const url = returnedUrl.startsWith("https://www.notion.so/")
    ? returnedUrl
    : `https://www.notion.so/${expectedId}`
  return { pageId: expectedId, url, lastEditedTime }
}
