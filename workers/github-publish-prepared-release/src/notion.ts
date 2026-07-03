import type { RuntimeConfig } from "./config.js"
import { normalizePageId } from "./policy.js"
import type { PublishPreparedReleaseInput } from "./types.js"

type UnknownRecord = Record<string, unknown>

export type NotionClientLike = {
  pages: {
    retrieve(args: { page_id: string }): Promise<unknown>
    update(args: {
      page_id: string
      properties: Record<string, unknown>
    }): Promise<unknown>
  }
}

export type NotionPacketSnapshot = {
  pageId: string
  url: string
  receiptJson: string
}

export class NotionPacketError extends Error {
  readonly kind: "conflict" | "unavailable"
  readonly retryable: boolean

  constructor(
    message: string,
    options: { kind: "conflict" | "unavailable"; retryable?: boolean }
  ) {
    super(message)
    this.name = "NotionPacketError"
    this.kind = options.kind
    this.retryable = options.retryable ?? false
  }
}

class NotionRequestTimeoutError extends Error {
  constructor() {
    super("Notion request exceeded its fixed timeout")
    this.name = "NotionRequestTimeoutError"
  }
}

async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NotionRequestTimeoutError()), timeoutMs)
  })
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" ? (value as UnknownRecord) : null
}

function propertyText(value: unknown): string | null {
  const property = record(value)
  if (!property) return null
  const type = property.type
  if (type === "status" || type === "select") {
    const selected = record(property[type])
    return typeof selected?.name === "string" ? selected.name : ""
  }
  if (type !== "rich_text" && type !== "title") return null
  const fragments = property[type]
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
  const value = record(error)?.status
  return typeof value === "number" ? value : null
}

function unavailable(error: unknown, action: string): NotionPacketError {
  const status = statusFromError(error)
  const suffix = status === null ? "" : ` (HTTP ${status})`
  return new NotionPacketError(`Notion ${action} failed${suffix}`, {
    kind: "unavailable",
    retryable:
      status === null ||
      status === 408 ||
      status === 429 ||
      status === 529 ||
      status >= 500,
  })
}

export class NotionPacketStore {
  constructor(
    private readonly notion: NotionClientLike,
    private readonly config: RuntimeConfig
  ) {}

  async verify(
    input: PublishPreparedReleaseInput,
    options: { requireApproved?: boolean } = {}
  ): Promise<NotionPacketSnapshot> {
    let page: unknown
    try {
      page = await withTimeout(
        () => this.notion.pages.retrieve({ page_id: input.approvalPageId }),
        this.config.notionRequestTimeoutMs
      )
    } catch (error) {
      throw unavailable(error, "approval read")
    }
    return this.verifyPage(page, input, options.requireApproved !== false)
  }

  async writeReceipt(
    input: PublishPreparedReleaseInput,
    receiptJson: string,
    options: { requireApproved?: boolean } = {}
  ): Promise<{ changed: boolean; pageId: string; url: string }> {
    if (Buffer.byteLength(receiptJson, "utf8") > 2_000) {
      throw new NotionPacketError(
        "receipt exceeds Notion's 2,000-byte text limit",
        {
          kind: "conflict",
        }
      )
    }

    const requireApproved = options.requireApproved !== false
    const before = await this.verify(input, { requireApproved })
    if (before.receiptJson === receiptJson) {
      return { changed: false, pageId: before.pageId, url: before.url }
    }
    if (before.receiptJson !== "") {
      throw new NotionPacketError(
        "Release receipt property already contains a different value",
        { kind: "conflict" }
      )
    }

    let updateError: unknown = null
    try {
      await withTimeout(
        () =>
          this.notion.pages.update({
            page_id: input.approvalPageId,
            properties: {
              [this.config.receiptProperty]: {
                rich_text: [
                  { type: "text", text: { content: receiptJson, link: null } },
                ],
              },
            },
          }),
        this.config.notionRequestTimeoutMs
      )
    } catch (error) {
      updateError = error
    }

    // Notion does not expose compare-and-set for page properties. Read back on
    // both success and failure, and claim the receipt only when the immutable
    // packet identity and exact value are authoritative after the assignment.
    let after: NotionPacketSnapshot
    try {
      after = await this.verify(input, { requireApproved })
    } catch (readbackError) {
      if (
        readbackError instanceof NotionPacketError &&
        readbackError.kind === "conflict"
      ) {
        throw readbackError
      }
      const updateRetryable =
        updateError === null ||
        unavailable(updateError, "receipt write").retryable
      const readbackRetryable = unavailable(
        readbackError,
        "receipt read-back"
      ).retryable
      throw new NotionPacketError(
        "Notion receipt write could not be confirmed by bounded read-back",
        {
          kind: "unavailable",
          retryable: updateRetryable || readbackRetryable,
        }
      )
    }
    if (after.receiptJson === receiptJson) {
      return { changed: true, pageId: after.pageId, url: after.url }
    }
    if (after.receiptJson !== "") {
      throw new NotionPacketError(
        "Release receipt changed before authoritative read-back",
        { kind: "conflict" }
      )
    }
    if (updateError !== null) {
      throw unavailable(
        updateError,
        "receipt write; read-back did not confirm it"
      )
    }
    throw new NotionPacketError(
      "Notion accepted the receipt update but read-back did not confirm it",
      { kind: "unavailable", retryable: true }
    )
  }

  private verifyPage(
    value: unknown,
    input: PublishPreparedReleaseInput,
    requireApproved: boolean
  ): NotionPacketSnapshot {
    const page = record(value)
    const properties = record(page?.properties)
    if (!page || !properties || typeof page.id !== "string") {
      throw new NotionPacketError("Notion returned an invalid release packet", {
        kind: "conflict",
      })
    }
    if (normalizePageId(page.id) !== normalizePageId(input.approvalPageId)) {
      throw new NotionPacketError(
        "Notion returned a different release packet",
        { kind: "conflict" }
      )
    }
    if (page.archived === true || page.in_trash === true) {
      throw new NotionPacketError("Release packet is archived or in trash", {
        kind: "conflict",
      })
    }
    const status = propertyText(properties[this.config.approvalStatusProperty])
    const revision = propertyText(
      properties[this.config.approvalRevisionProperty]
    )
    const fingerprint = propertyText(
      properties[this.config.approvalFingerprintProperty]
    )
    const receipt = propertyText(properties[this.config.receiptProperty])

    if (requireApproved && status !== this.config.approvedStatus) {
      throw new NotionPacketError("Release packet is not currently approved", {
        kind: "conflict",
      })
    }
    if (revision !== input.approvalRevision) {
      throw new NotionPacketError("Release packet approval revision is stale", {
        kind: "conflict",
      })
    }
    if (fingerprint !== input.approvalFingerprint) {
      throw new NotionPacketError("Release packet fingerprint is stale", {
        kind: "conflict",
      })
    }
    if (receipt === null) {
      throw new NotionPacketError(
        `Notion property "${this.config.receiptProperty}" must be rich text`,
        { kind: "conflict" }
      )
    }

    return {
      pageId: normalizePageId(page.id),
      // Return a canonical link derived from the verified page ID instead of
      // trusting a provider-returned URL in the durable receipt.
      url: `https://www.notion.so/${normalizePageId(page.id)}`,
      receiptJson: receipt,
    }
  }
}
