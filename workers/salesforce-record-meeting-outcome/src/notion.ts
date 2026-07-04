import type { Client } from "@notionhq/client"

import type { RuntimeConfig } from "./config.js"
import { PolicyError } from "./policy.js"
import { boundedRetryAfterSeconds } from "./retry.js"
import type { NotionGateway, NotionPageState, NotionReceipt } from "./types.js"

type PageProperty = Record<string, unknown> & { type?: unknown }
type PageResponse = Record<string, unknown> & {
  id?: unknown
  url?: unknown
  archived?: unknown
  in_trash?: unknown
  properties?: unknown
}

export const NOTION_REQUEST_TIMEOUT_MS = 10_000

export class NotionRequestTimeoutError extends Error {
  constructor() {
    super("Notion did not respond within the fixed request budget.")
    this.name = "NotionRequestTimeoutError"
  }
}

export class NotionWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NotionWriteError"
  }
}

export class NotionProviderError extends Error {
  constructor(
    message: string,
    readonly kind: "blocked" | "retryable",
    readonly retryAfterSeconds: number | null = null
  ) {
    super(message)
    this.name = "NotionProviderError"
  }
}

function errorRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizeNotionProviderError(
  error: unknown,
  action: "read" | "write"
): Error {
  if (
    error instanceof PolicyError ||
    error instanceof NotionRequestTimeoutError ||
    error instanceof NotionProviderError
  ) {
    return error
  }

  const record = errorRecord(error)
  const status = typeof record?.status === "number" ? record.status : null
  const code = typeof record?.code === "string" ? record.code.toLowerCase() : ""
  const retryableCodes = new Set([
    "bad_gateway",
    "conflict_error",
    "database_connection_unavailable",
    "gateway_timeout",
    "internal_server_error",
    "notionhq_client_request_timeout",
    "rate_limited",
    "service_overload",
    "service_unavailable",
  ])
  const transientStatus =
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    (status !== null && status >= 500)
  const retryable =
    transientStatus ||
    retryableCodes.has(code) ||
    // A raw transport exception has neither an HTTP status nor a Notion API
    // error code. Known API/SDK codes that are not in the transient set are
    // permanent and must not be retried blindly.
    (status === null && code === "")

  return new NotionProviderError(
    retryable
      ? `Notion could not complete the page ${action}; retry is safe.`
      : `Notion rejected the page ${action}; access or page configuration must be repaired.`,
    retryable ? "retryable" : "blocked",
    retryable ? boundedRetryAfterSeconds(record?.headers) : null
  )
}

async function withNotionTimeout<T>(
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

function propertyMap(page: PageResponse): Record<string, PageProperty> {
  if (
    page.properties == null ||
    typeof page.properties !== "object" ||
    Array.isArray(page.properties)
  ) {
    throw new PolicyError("The Notion page has no readable properties.")
  }
  return page.properties as Record<string, PageProperty>
}

function richTextPlainText(value: unknown): string {
  if (!Array.isArray(value)) return ""
  return value
    .map((item) => {
      if (item == null || typeof item !== "object") return ""
      const plainText = (item as Record<string, unknown>).plain_text
      return typeof plainText === "string" ? plainText : ""
    })
    .join("")
}

function textProperty(property: PageProperty, propertyName: string): string {
  if (property.type === "rich_text") {
    return richTextPlainText(property.rich_text)
  }
  if (property.type === "title") {
    return richTextPlainText(property.title)
  }
  throw new PolicyError(
    `${propertyName} must be a rich text or title property.`
  )
}

function selectedName(value: unknown): string {
  if (value == null || typeof value !== "object") return ""
  const name = (value as Record<string, unknown>).name
  return typeof name === "string" ? name : ""
}

function approvalMatches(
  property: PageProperty,
  approvedValue: string
): boolean {
  if (property.type === "status") {
    return selectedName(property.status) === approvedValue
  }
  if (property.type === "select") {
    return selectedName(property.select) === approvedValue
  }
  if (property.type === "checkbox") {
    return property.checkbox === true
  }
  throw new PolicyError(
    "The approval property must be a status, select, or checkbox property."
  )
}

function safeNotionUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new PolicyError("The Notion page response is missing its URL.")
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new PolicyError("The Notion page response returned an invalid URL.")
  }
  if (url.protocol !== "https:") {
    throw new PolicyError("The Notion page URL must use HTTPS.")
  }
  return url.toString()
}

function canonicalResponsePageId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.replace(/-/g, "").toLowerCase()
  return /^[a-f0-9]{32}$/.test(normalized) ? normalized : null
}

function assertMatchingPageId(
  value: unknown,
  expectedPageId: string,
  action: "read" | "update"
): void {
  const page =
    value != null && typeof value === "object" && !Array.isArray(value)
      ? (value as PageResponse)
      : null
  const actual = canonicalResponsePageId(page?.id)
  const expected = canonicalResponsePageId(expectedPageId)
  if (!actual || !expected || actual !== expected) {
    throw new PolicyError(
      `Notion ${action} returned a different or invalid page identity.`,
      "conflict"
    )
  }
}

function serializeReceipt(receipt: NotionReceipt): string {
  const value = JSON.stringify(receipt)
  if (value.length > 1_900) {
    throw new PolicyError(
      "The compact Notion receipt exceeds 1,900 characters."
    )
  }
  return value
}

function sameReceipt(current: string, expected: NotionReceipt): boolean {
  if (!current.trim()) return false
  try {
    const parsed = JSON.parse(current) as Partial<NotionReceipt>
    const keys = Object.keys(parsed).sort()
    const expectedKeys = [
      "activityId",
      "followUpIds",
      "idempotencyKey",
      "inputFingerprint",
      "operationId",
      "opportunityId",
      "version",
    ]
    return (
      JSON.stringify(keys) === JSON.stringify(expectedKeys) &&
      parsed.version === 1 &&
      parsed.operationId === expected.operationId &&
      parsed.idempotencyKey === expected.idempotencyKey &&
      parsed.inputFingerprint === expected.inputFingerprint &&
      parsed.opportunityId === expected.opportunityId &&
      parsed.activityId === expected.activityId &&
      JSON.stringify(parsed.followUpIds) ===
        JSON.stringify(expected.followUpIds)
    )
  } catch {
    return false
  }
}

async function retrievePage(
  notion: Client,
  pageId: string,
  config: RuntimeConfig,
  timeoutMs: number
): Promise<NotionPageState> {
  let page: PageResponse
  try {
    page = (await withNotionTimeout(
      () => notion.pages.retrieve({ page_id: pageId }),
      timeoutMs
    )) as PageResponse
  } catch (error) {
    throw normalizeNotionProviderError(error, "read")
  }
  assertMatchingPageId(page, pageId, "read")
  if (page.archived === true || page.in_trash === true) {
    throw new PolicyError("The approved Notion page is archived or in trash.")
  }

  const properties = propertyMap(page)
  const approvalProperty = properties[config.approvalProperty]
  const revisionProperty = properties[config.revisionProperty]
  const fingerprintProperty = properties[config.fingerprintProperty]
  const receiptProperty = properties[config.receiptProperty]
  if (!approvalProperty) {
    throw new PolicyError(
      `Notion page is missing approval property ${config.approvalProperty}.`
    )
  }
  if (!revisionProperty) {
    throw new PolicyError(
      `Notion page is missing revision property ${config.revisionProperty}.`
    )
  }
  if (!receiptProperty) {
    throw new PolicyError(
      `Notion page is missing receipt property ${config.receiptProperty}.`
    )
  }
  if (!fingerprintProperty) {
    throw new PolicyError(
      `Notion page is missing fingerprint property ${config.fingerprintProperty}.`
    )
  }
  if (receiptProperty.type !== "rich_text") {
    throw new PolicyError(
      `${config.receiptProperty} must be a rich text property.`
    )
  }

  return {
    pageId,
    url: safeNotionUrl(page.url),
    approved: approvalMatches(approvalProperty, config.approvedValue),
    approvedRevision: textProperty(
      revisionProperty,
      config.revisionProperty
    ).trim(),
    approvedFingerprint: textProperty(
      fingerprintProperty,
      config.fingerprintProperty
    ).trim(),
    currentReceipt: richTextPlainText(receiptProperty.rich_text),
  }
}

export function createNotionGateway(
  notion: Client,
  config: RuntimeConfig,
  options: { requestTimeoutMs?: number } = {}
): NotionGateway {
  const timeoutMs = options.requestTimeoutMs ?? NOTION_REQUEST_TIMEOUT_MS
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > NOTION_REQUEST_TIMEOUT_MS
  ) {
    throw new Error(
      `Notion request timeout must be between 1 and ${NOTION_REQUEST_TIMEOUT_MS} milliseconds.`
    )
  }
  return {
    readPage: (pageId) => retrievePage(notion, pageId, config, timeoutMs),
    async ensureReceipt(pageId, approvedRevision, receipt) {
      const expected = serializeReceipt(receipt)
      const before = await retrievePage(notion, pageId, config, timeoutMs)
      if (!before.approved) {
        throw new PolicyError(
          "The Notion meeting outcome is no longer approved.",
          "conflict"
        )
      }
      if (before.approvedRevision !== approvedRevision) {
        throw new PolicyError(
          "The approved Notion revision changed before receipt writeback.",
          "conflict"
        )
      }
      if (before.approvedFingerprint !== receipt.inputFingerprint) {
        throw new PolicyError(
          "The approved Notion fingerprint changed before receipt writeback.",
          "conflict"
        )
      }
      if (sameReceipt(before.currentReceipt, receipt)) return "unchanged"
      if (before.currentReceipt.trim()) {
        throw new PolicyError(
          "The Notion receipt property contains a different operation.",
          "conflict"
        )
      }

      let updateError: unknown = null
      try {
        const updated = await withNotionTimeout(
          () =>
            notion.pages.update({
              page_id: pageId,
              properties: {
                [config.receiptProperty]: {
                  type: "rich_text",
                  rich_text: [
                    {
                      type: "text",
                      text: { content: expected },
                    },
                  ],
                },
              },
            }),
          timeoutMs
        )
        assertMatchingPageId(updated, pageId, "update")
      } catch (error) {
        updateError = normalizeNotionProviderError(error, "write")
      }

      // Always re-read after the assignment, including after an HTTP success.
      // This closes response-identity mistakes and races where another writer
      // changes approval metadata or the reserved receipt property.
      const after = await retrievePage(notion, pageId, config, timeoutMs)
      if (!after.approved) {
        throw new PolicyError(
          "The Notion meeting outcome is no longer approved.",
          "conflict"
        )
      }
      if (after.approvedRevision !== approvedRevision) {
        throw new PolicyError(
          "The approved Notion revision changed during receipt writeback.",
          "conflict"
        )
      }
      if (after.approvedFingerprint !== receipt.inputFingerprint) {
        throw new PolicyError(
          "The approved Notion fingerprint changed during receipt writeback.",
          "conflict"
        )
      }
      if (sameReceipt(after.currentReceipt, receipt)) return "written"
      if (after.currentReceipt.trim()) {
        throw new PolicyError(
          "The Notion receipt property changed during receipt writeback.",
          "conflict"
        )
      }
      if (updateError instanceof Error) throw updateError
      throw new NotionWriteError(
        "Salesforce committed, but the Notion receipt could not be confirmed."
      )
    },
  }
}

export const notionReceiptText = serializeReceipt
