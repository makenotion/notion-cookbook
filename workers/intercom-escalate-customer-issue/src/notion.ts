import {
  canonicalPacket,
  canonicalReceipt,
  packetFingerprint,
  parsePacket,
  validateStoredReceipt,
} from "./canonical.js"
import type { RuntimeConfig } from "./config.js"
import type {
  ApprovalSnapshot,
  EscalationInput,
  NotionClientLike,
  StoredReceipt,
} from "./types.js"
import { SafetyError } from "./types.js"

function normalizeId(value: string): string {
  return value.replace(/-/g, "").toLowerCase()
}

async function notionCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch {
    throw new SafetyError(
      "NOTION_UNAVAILABLE",
      "Notion did not complete the approval or receipt request; no raw error was exposed.",
      "blocked",
      true
    )
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SafetyError(
      "APPROVAL_SCHEMA",
      `The Notion ${label} is malformed.`
    )
  }
  return value as Record<string, unknown>
}

function statusProperty(
  properties: Record<string, unknown>,
  name: string
): string {
  const property = object(properties[name], `property ${JSON.stringify(name)}`)
  const status = property.status ?? property.select
  const value = object(status, `status ${JSON.stringify(name)}`).name
  if (typeof value !== "string" || value.length < 1 || value.length > 100) {
    throw new SafetyError(
      "APPROVAL_SCHEMA",
      `The Notion status ${JSON.stringify(name)} is invalid.`
    )
  }
  return value
}

function textProperty(
  properties: Record<string, unknown>,
  name: string,
  maximum: number,
  allowEmpty: boolean
): string | null {
  const property = object(properties[name], `property ${JSON.stringify(name)}`)
  const richText = property.rich_text
  if (!Array.isArray(richText) || richText.length > 12) {
    throw new SafetyError(
      "APPROVAL_SCHEMA",
      `The Notion property ${JSON.stringify(name)} is not bounded rich text.`
    )
  }
  let value = ""
  for (const fragment of richText) {
    const item = object(
      fragment,
      `rich-text fragment in ${JSON.stringify(name)}`
    )
    const plainText = item.plain_text
    if (typeof plainText !== "string") {
      throw new SafetyError(
        "APPROVAL_SCHEMA",
        `The Notion property ${JSON.stringify(name)} has invalid text.`
      )
    }
    value += plainText
    if (value.length > maximum) {
      throw new SafetyError(
        "APPROVAL_SCHEMA",
        `The Notion property ${JSON.stringify(name)} exceeds ${maximum} characters.`
      )
    }
  }
  if (!value) {
    if (allowEmpty) return null
    throw new SafetyError(
      "APPROVAL_SCHEMA",
      `The Notion property ${JSON.stringify(name)} is empty.`
    )
  }
  return value
}

export async function retrieveApproval(
  notion: NotionClientLike,
  input: EscalationInput,
  config: RuntimeConfig
): Promise<ApprovalSnapshot> {
  const raw = object(
    await notionCall(() =>
      notion.pages.retrieve({ page_id: input.approvalPageId })
    ),
    "page"
  )
  if (
    raw.object !== "page" ||
    raw.archived === true ||
    raw.in_trash === true ||
    typeof raw.id !== "string" ||
    normalizeId(raw.id) !== normalizeId(input.approvalPageId) ||
    typeof raw.last_edited_time !== "string" ||
    Number.isNaN(Date.parse(raw.last_edited_time))
  ) {
    throw new SafetyError(
      "APPROVAL_SCHEMA",
      "The approval must be the exact active Notion page."
    )
  }
  const properties = object(raw.properties, "page properties")
  const packetText = textProperty(
    properties,
    config.packetProperty,
    8_000,
    false
  ) as string
  let packetValue: unknown
  try {
    packetValue = JSON.parse(packetText)
  } catch {
    throw new SafetyError(
      "APPROVAL_SCHEMA",
      "The escalation packet is not valid JSON."
    )
  }
  const packet = parsePacket(packetValue)
  if (packetText !== canonicalPacket(packet)) {
    throw new SafetyError(
      "APPROVAL_NOT_CANONICAL",
      "The escalation packet must use the canonical compact JSON emitted by the fingerprint helper."
    )
  }
  return {
    pageId: raw.id,
    pageLastEditedTime: new Date(raw.last_edited_time).toISOString(),
    status: statusProperty(properties, config.statusProperty),
    revision: textProperty(
      properties,
      config.revisionProperty,
      100,
      false
    ) as string,
    fingerprint: textProperty(
      properties,
      config.fingerprintProperty,
      64,
      false
    ) as string,
    packetText,
    packet,
    receiptText: textProperty(properties, config.receiptProperty, 1_900, true),
  }
}

export function verifyApproval(
  snapshot: ApprovalSnapshot,
  input: EscalationInput,
  config: RuntimeConfig
): void {
  if (snapshot.status !== config.approvedValue) {
    throw new SafetyError(
      "APPROVAL_REVOKED",
      "The Notion escalation status is not Approved."
    )
  }
  if (snapshot.revision !== input.approvalRevision) {
    throw new SafetyError(
      "APPROVAL_STALE",
      "The approved Notion revision changed.",
      "conflict"
    )
  }
  if (
    snapshot.fingerprint !== input.approvalFingerprint ||
    packetFingerprint(snapshot.packet) !== input.approvalFingerprint
  ) {
    throw new SafetyError(
      "APPROVAL_FINGERPRINT_MISMATCH",
      "The supplied, stored, and calculated approval fingerprints must match.",
      "conflict"
    )
  }
  if (
    snapshot.packet.sourceKind !== input.sourceKind ||
    snapshot.packet.sourceId !== input.sourceId
  ) {
    throw new SafetyError(
      "APPROVAL_TARGET_MISMATCH",
      "The approved Intercom source differs from the tool input.",
      "conflict"
    )
  }
}

export async function writeReceipt(
  notion: NotionClientLike,
  input: EscalationInput,
  config: RuntimeConfig,
  receipt: StoredReceipt
): Promise<"written" | "already_written"> {
  validateStoredReceipt(receipt)
  const before = await retrieveApproval(notion, input, config)
  verifyApproval(before, input, config)
  const encoded = canonicalReceipt(receipt)
  if (encoded.length > 1_900)
    throw new SafetyError(
      "RECEIPT_TOO_LARGE",
      "The canonical receipt exceeds the Notion bound."
    )
  if (before.receiptText) {
    if (before.receiptText === encoded) return "already_written"
    throw new SafetyError(
      "RECEIPT_OCCUPIED",
      "The receipt property contains different content.",
      "conflict"
    )
  }
  await notionCall(() =>
    notion.pages.update({
      page_id: input.approvalPageId,
      properties: {
        [config.receiptProperty]: {
          rich_text: [{ type: "text", text: { content: encoded } }],
        },
      },
    })
  )
  const after = await retrieveApproval(notion, input, config)
  verifyApproval(after, input, config)
  if (after.receiptText !== encoded) {
    throw new SafetyError(
      "RECEIPT_READBACK_FAILED",
      "Notion did not return the exact canonical receipt after writeback.",
      "partial_failure",
      true
    )
  }
  return "written"
}
