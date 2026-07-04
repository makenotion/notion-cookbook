import type { RuntimeConfig } from "./config.js"
import { normalizePageId } from "./policy.js"
import type { PublishImplementationPlanInput } from "./types.js"

type JsonRecord = Record<string, unknown>

export type NotionClientLike = {
  pages: {
    retrieve(args: { page_id: string }): Promise<unknown>
    update(args: {
      page_id: string
      properties: Record<string, unknown>
    }): Promise<unknown>
  }
}

export type ApprovalSnapshot = {
  pageId: string
  url: string
  receiptJson: string
}

export class NotionPlanError extends Error {
  readonly kind: "conflict" | "unavailable"
  readonly retryable: boolean

  constructor(
    message: string,
    options: { kind: "conflict" | "unavailable"; retryable?: boolean }
  ) {
    super(message)
    this.name = "NotionPlanError"
    this.kind = options.kind
    this.retryable = options.retryable ?? false
  }
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

function approvalPropertyText(value: unknown): string | null {
  const property = record(value)
  if (!property) return null
  const type = property.type
  if (type === "status" || type === "select") {
    const selected = record(property[type])
    return typeof selected?.name === "string" ? selected.name : ""
  }
  return null
}

function richTextPropertyText(value: unknown): string | null {
  const property = record(value)
  if (!property || property.type !== "rich_text") return null
  const fragments = property.rich_text
  if (!Array.isArray(fragments)) return null
  return fragments
    .map((fragment) => {
      const part = record(fragment)
      if (typeof part?.plain_text === "string") return part.plain_text
      const text = record(part?.text)
      return typeof text?.content === "string" ? text.content : ""
    })
    .join("")
}

function statusFromError(error: unknown): number | null {
  const status = record(error)?.status
  return typeof status === "number" ? status : null
}

async function withTimeout<T>(
  operation: () => Promise<T>,
  ms: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Notion timeout")), ms)
  })
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function unavailable(error: unknown, action: string): NotionPlanError {
  const status = statusFromError(error)
  return new NotionPlanError(
    `Notion ${action} failed${status === null ? "" : ` (HTTP ${status})`}`,
    {
      kind: "unavailable",
      retryable:
        status === null ||
        status === 408 ||
        status === 429 ||
        status === 529 ||
        status >= 500,
    }
  )
}

function splitUtf8(value: string, maxBytes: number): string[] {
  const chunks: string[] = []
  let chunk = ""
  let bytes = 0
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8")
    if (bytes + size > maxBytes && chunk.length > 0) {
      chunks.push(chunk)
      chunk = ""
      bytes = 0
    }
    chunk += character
    bytes += size
  }
  if (chunk.length > 0) chunks.push(chunk)
  return chunks
}

export class NotionPlanStore {
  constructor(
    private readonly notion: NotionClientLike,
    private readonly config: RuntimeConfig
  ) {}

  async verify(
    input: PublishImplementationPlanInput,
    options: { requireApproved?: boolean; requireEmptyReceipt?: boolean } = {}
  ): Promise<ApprovalSnapshot> {
    let page: unknown
    try {
      page = await withTimeout(
        () => this.notion.pages.retrieve({ page_id: input.approvalPageId }),
        this.config.notionRequestTimeoutMs
      )
    } catch (error) {
      throw unavailable(error, "approval read")
    }
    const value = record(page)
    const id = typeof value?.id === "string" ? normalizePageId(value.id) : null
    const properties = record(value?.properties)
    if (
      !id ||
      id !== normalizePageId(input.approvalPageId) ||
      !properties ||
      value?.archived === true ||
      value?.in_trash === true
    ) {
      throw new NotionPlanError("Notion approval page identity is invalid", {
        kind: "conflict",
      })
    }
    const approval = approvalPropertyText(
      properties[this.config.approvalStatusProperty]
    )
    const revision = richTextPropertyText(
      properties[this.config.approvalRevisionProperty]
    )
    const planHash = richTextPropertyText(
      properties[this.config.planHashProperty]
    )
    const receipt = richTextPropertyText(
      properties[this.config.receiptProperty]
    )
    if ([approval, revision, planHash, receipt].some((item) => item === null)) {
      throw new NotionPlanError(
        "Notion approval page is missing a configured typed property",
        { kind: "conflict" }
      )
    }
    if (
      options.requireApproved !== false &&
      approval !== this.config.approvedStatus
    ) {
      throw new NotionPlanError("Notion approval is not currently approved", {
        kind: "conflict",
      })
    }
    if (revision !== input.approvalRevision) {
      throw new NotionPlanError("Notion approval revision is stale", {
        kind: "conflict",
      })
    }
    if (planHash !== input.planHash) {
      throw new NotionPlanError("Notion approved plan hash is stale", {
        kind: "conflict",
      })
    }
    if (Buffer.byteLength(receipt as string, "utf8") > 20_000) {
      throw new NotionPlanError("Existing Notion receipt is oversized", {
        kind: "conflict",
      })
    }
    if (options.requireEmptyReceipt && receipt !== "") {
      throw new NotionPlanError(
        "Notion Jira publication receipt must be empty before the initial claim",
        { kind: "conflict" }
      )
    }
    const url = `https://www.notion.so/${id}`
    return { pageId: id, url, receiptJson: receipt as string }
  }

  async writeReceipt(
    input: PublishImplementationPlanInput,
    receiptJson: string
  ): Promise<{ changed: boolean; pageId: string; url: string }> {
    if (Buffer.byteLength(receiptJson, "utf8") > 20_000) {
      throw new NotionPlanError("Canonical Jira receipt exceeds 20,000 bytes", {
        kind: "conflict",
      })
    }
    // Receipt completion is an audit writeback after Jira may already have
    // changed. Preserve exact revision/hash checks, but do not let a later
    // approval-status change erase the audit trail.
    const before = await this.verify(input, { requireApproved: false })
    if (before.receiptJson === receiptJson) {
      return { changed: false, pageId: before.pageId, url: before.url }
    }
    if (before.receiptJson !== "") {
      throw new NotionPlanError(
        "Jira publication receipt already contains a different value",
        { kind: "conflict" }
      )
    }
    const chunks = splitUtf8(receiptJson, 1_800)
    try {
      await withTimeout(
        () =>
          this.notion.pages.update({
            page_id: input.approvalPageId,
            properties: {
              [this.config.receiptProperty]: {
                rich_text: chunks.map((content) => ({
                  type: "text",
                  text: { content, link: null },
                })),
              },
            },
          }),
        this.config.notionRequestTimeoutMs
      )
    } catch (error) {
      // The update may have reached Notion. Exact read-back resolves that
      // ambiguity without overwriting a different receipt.
      try {
        const afterError = await this.verify(input, { requireApproved: false })
        if (afterError.receiptJson === receiptJson) {
          return {
            changed: true,
            pageId: afterError.pageId,
            url: afterError.url,
          }
        }
      } catch {
        // Preserve the original redacted write failure below.
      }
      throw unavailable(error, "receipt write")
    }
    const after = await this.verify(input, { requireApproved: false })
    if (after.receiptJson !== receiptJson) {
      throw new NotionPlanError(
        "Notion receipt write did not read back exactly",
        {
          kind: "unavailable",
          retryable: true,
        }
      )
    }
    return { changed: true, pageId: after.pageId, url: after.url }
  }
}
