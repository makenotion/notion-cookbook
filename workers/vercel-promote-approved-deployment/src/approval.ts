import { createHash } from "node:crypto"
import {
  APPROVAL_PROPERTIES,
  type ApprovalPacket,
  type ApprovalSnapshot,
  type NotionClientLike,
  type PromoteInput,
  type PromotionResult,
  SafetyError,
} from "./types.js"

const NOTION_REQUEST_TIMEOUT_MS = 10_000

async function notionRequest<T>(operation: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new SafetyError(
            "NOTION_TIMEOUT",
            "The Notion request exceeded the fixed timeout."
          )
        ),
      NOTION_REQUEST_TIMEOUT_MS
    )
    operation().then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function normalizedId(value: string): string {
  return value.replaceAll("-", "").toLowerCase()
}

function textProperty(
  properties: Record<string, unknown>,
  name: string,
  maximum: number
): string {
  const raw = properties[name]
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SafetyError(
      "APPROVAL_SCHEMA",
      `The approval page is missing the ${JSON.stringify(name)} property.`
    )
  }
  const property = raw as Record<string, unknown>
  const type = property.type
  if (type !== "rich_text" && type !== "title") {
    throw new SafetyError(
      "APPROVAL_SCHEMA",
      `${JSON.stringify(name)} must be a rich_text or title property.`
    )
  }
  const fragments = property[type]
  if (!Array.isArray(fragments)) {
    throw new SafetyError(
      "APPROVAL_SCHEMA",
      `${JSON.stringify(name)} has an invalid text value.`
    )
  }
  let value = ""
  for (const fragment of fragments) {
    if (!fragment || typeof fragment !== "object") continue
    const object = fragment as Record<string, unknown>
    if (typeof object.plain_text === "string") value += object.plain_text
    if (value.length > maximum) {
      throw new SafetyError(
        "APPROVAL_SCHEMA",
        `${JSON.stringify(name)} exceeds its maximum length.`
      )
    }
  }
  if (!value || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SafetyError(
      "APPROVAL_SCHEMA",
      `${JSON.stringify(name)} must be non-empty, exact, and contain no control characters.`
    )
  }
  return value
}

function optionalRichTextProperty(
  properties: Record<string, unknown>,
  name: string
): string {
  const raw = properties[name]
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SafetyError(
      "RECEIPT_SCHEMA",
      `The approval page is missing the ${JSON.stringify(name)} receipt property.`
    )
  }
  const property = raw as Record<string, unknown>
  if (property.type !== "rich_text" || !Array.isArray(property.rich_text)) {
    throw new SafetyError(
      "RECEIPT_SCHEMA",
      `${JSON.stringify(name)} must be a rich_text property.`
    )
  }
  let value = ""
  for (const fragment of property.rich_text) {
    if (!fragment || typeof fragment !== "object") continue
    const object = fragment as Record<string, unknown>
    if (typeof object.plain_text === "string") value += object.plain_text
    if (value.length > 1_900) {
      throw new SafetyError(
        "RECEIPT_SCHEMA",
        `${JSON.stringify(name)} exceeds the receipt length bound.`
      )
    }
  }
  return value
}

function statusProperty(properties: Record<string, unknown>): "Approved" {
  const name = APPROVAL_PROPERTIES.status
  const raw = properties[name]
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SafetyError(
      "APPROVAL_SCHEMA",
      `The approval page is missing the ${JSON.stringify(name)} property.`
    )
  }
  const property = raw as Record<string, unknown>
  let value: unknown
  if (property.type === "status") {
    value = (property.status as Record<string, unknown> | null)?.name
  } else if (property.type === "select") {
    value = (property.select as Record<string, unknown> | null)?.name
  } else {
    throw new SafetyError(
      "APPROVAL_SCHEMA",
      `${JSON.stringify(name)} must be a status or select property.`
    )
  }
  if (
    typeof value !== "string" ||
    value.length > 32 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new SafetyError(
      "APPROVAL_SCHEMA",
      "The approval status value is invalid or oversized."
    )
  }
  if (value !== "Approved") {
    throw new SafetyError(
      "NOT_APPROVED",
      'The approval status must be exactly "Approved".'
    )
  }
  return value
}

export function canonicalApprovalJson(packet: ApprovalPacket): string {
  return JSON.stringify({
    approvalStatus: packet.approvalStatus,
    approvalRevision: packet.approvalRevision,
    teamId: packet.teamId,
    projectId: packet.projectId,
    deploymentId: packet.deploymentId,
    gitSha: packet.gitSha,
    gitBranch: packet.gitBranch,
    expectedCurrentDeploymentId: packet.expectedCurrentDeploymentId,
  })
}

export function approvalFingerprint(packet: ApprovalPacket): string {
  return createHash("sha256")
    .update(canonicalApprovalJson(packet))
    .digest("hex")
}

export function operationIdentity(input: PromoteInput): {
  operationId: string
  operationKey: string
  leaseKey: string
} {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        approvalPageId: normalizedId(input.approvalPageId),
        approvalRevision: input.approvalRevision,
        approvalFingerprint: input.approvalFingerprint,
        teamId: input.teamId,
        projectId: input.projectId,
        deploymentId: input.deploymentId,
        expectedGitSha: input.expectedGitSha,
        expectedGitBranch: input.expectedGitBranch,
        expectedCurrentDeploymentId: input.expectedCurrentDeploymentId,
      })
    )
    .digest("hex")
  const projectDigest = createHash("sha256")
    .update(`${input.teamId}:${input.projectId}`)
    .digest("hex")
  const operationId = `vpa_${digest.slice(0, 32)}`
  return {
    operationId,
    operationKey: `vercel-promotion:operation:${operationId}`,
    leaseKey: `vercel-promotion:project-lease:${projectDigest}`,
  }
}

export async function retrieveApproval(
  notion: NotionClientLike,
  pageId: string,
  receiptProperty: string
): Promise<ApprovalSnapshot> {
  const raw = await notionRequest(() =>
    notion.pages.retrieve({ page_id: pageId })
  )
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SafetyError("APPROVAL_SCHEMA", "Notion returned an invalid page.")
  }
  const page = raw as Record<string, unknown>
  if (
    page.object !== "page" ||
    page.archived === true ||
    page.in_trash === true
  ) {
    throw new SafetyError(
      "APPROVAL_SCHEMA",
      "The approval page must be an active Notion page."
    )
  }
  if (
    typeof page.id !== "string" ||
    normalizedId(page.id) !== normalizedId(pageId)
  ) {
    throw new SafetyError(
      "APPROVAL_SCHEMA",
      "Notion returned a different approval page ID."
    )
  }
  if (typeof page.last_edited_time !== "string") {
    throw new SafetyError(
      "APPROVAL_SCHEMA",
      "The approval page has no last_edited_time revision."
    )
  }
  const revision = new Date(page.last_edited_time)
  if (Number.isNaN(revision.getTime())) {
    throw new SafetyError(
      "APPROVAL_SCHEMA",
      "The approval page revision is invalid."
    )
  }
  if (!page.properties || typeof page.properties !== "object") {
    throw new SafetyError(
      "APPROVAL_SCHEMA",
      "The approval page has no properties."
    )
  }
  const properties = page.properties as Record<string, unknown>
  const packet: ApprovalPacket = {
    approvalStatus: statusProperty(properties),
    approvalRevision: textProperty(
      properties,
      APPROVAL_PROPERTIES.revision,
      100
    ),
    teamId: textProperty(properties, APPROVAL_PROPERTIES.teamId, 100),
    projectId: textProperty(properties, APPROVAL_PROPERTIES.projectId, 100),
    deploymentId: textProperty(
      properties,
      APPROVAL_PROPERTIES.deploymentId,
      100
    ),
    gitSha: textProperty(properties, APPROVAL_PROPERTIES.gitSha, 64),
    gitBranch: textProperty(properties, APPROVAL_PROPERTIES.gitBranch, 256),
    expectedCurrentDeploymentId: textProperty(
      properties,
      APPROVAL_PROPERTIES.expectedCurrentDeploymentId,
      100
    ),
  }
  const storedFingerprint = textProperty(
    properties,
    APPROVAL_PROPERTIES.fingerprint,
    64
  )
  return {
    pageId,
    revision: packet.approvalRevision,
    pageLastEditedTime: revision.toISOString(),
    fingerprint: storedFingerprint,
    packet,
    receiptText: optionalRichTextProperty(properties, receiptProperty),
  }
}

export function verifyApproval(
  snapshot: ApprovalSnapshot,
  input: PromoteInput,
  options: { requireRevision: boolean }
): void {
  if (options.requireRevision && snapshot.revision !== input.approvalRevision) {
    throw new SafetyError(
      "APPROVAL_REVISION_MISMATCH",
      "The approval page revision does not match the approved input."
    )
  }
  const calculated = approvalFingerprint(snapshot.packet)
  if (
    snapshot.fingerprint !== input.approvalFingerprint ||
    calculated !== input.approvalFingerprint
  ) {
    throw new SafetyError(
      "APPROVAL_FINGERPRINT_MISMATCH",
      "The supplied, stored, and calculated approval fingerprints must match."
    )
  }
  const expected: ApprovalPacket = {
    approvalStatus: "Approved",
    approvalRevision: input.approvalRevision,
    teamId: input.teamId,
    projectId: input.projectId,
    deploymentId: input.deploymentId,
    gitSha: input.expectedGitSha,
    gitBranch: input.expectedGitBranch,
    expectedCurrentDeploymentId: input.expectedCurrentDeploymentId,
  }
  if (
    canonicalApprovalJson(snapshot.packet) !== canonicalApprovalJson(expected)
  ) {
    throw new SafetyError(
      "APPROVAL_PACKET_MISMATCH",
      "The exact approved target does not match the tool input."
    )
  }
}

interface StoredReceipt {
  version: 1
  operationId: string
  status: "promoted"
  teamId: string
  projectId: string
  deploymentId: string
  previousDeploymentId: string
  gitSha: string
  approvalFingerprint: string
  verifiedAt: string
}

const STORED_RECEIPT_KEYS = new Set([
  "version",
  "operationId",
  "status",
  "teamId",
  "projectId",
  "deploymentId",
  "previousDeploymentId",
  "gitSha",
  "approvalFingerprint",
  "verifiedAt",
])

export function matchingStoredReceipt(
  snapshot: ApprovalSnapshot,
  input: PromoteInput,
  operationId: string
): StoredReceipt | null {
  if (!snapshot.receiptText) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(snapshot.receiptText)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null
  const object = parsed as Record<string, unknown>
  if (
    Object.keys(object).length !== STORED_RECEIPT_KEYS.size ||
    Object.keys(object).some((key) => !STORED_RECEIPT_KEYS.has(key))
  ) {
    return null
  }
  const receipt = object as Partial<StoredReceipt>
  if (
    receipt.version !== 1 ||
    receipt.operationId !== operationId ||
    receipt.status !== "promoted" ||
    receipt.teamId !== input.teamId ||
    receipt.projectId !== input.projectId ||
    receipt.deploymentId !== input.deploymentId ||
    receipt.previousDeploymentId !== input.expectedCurrentDeploymentId ||
    receipt.gitSha !== input.expectedGitSha ||
    receipt.approvalFingerprint !== input.approvalFingerprint ||
    typeof receipt.verifiedAt !== "string"
  ) {
    return null
  }
  const verifiedAt = new Date(receipt.verifiedAt)
  if (
    Number.isNaN(verifiedAt.getTime()) ||
    verifiedAt.toISOString() !== receipt.verifiedAt
  ) {
    return null
  }
  const canonical: StoredReceipt = {
    version: 1,
    operationId,
    status: "promoted",
    teamId: input.teamId,
    projectId: input.projectId,
    deploymentId: input.deploymentId,
    previousDeploymentId: input.expectedCurrentDeploymentId,
    gitSha: input.expectedGitSha,
    approvalFingerprint: input.approvalFingerprint,
    verifiedAt: receipt.verifiedAt,
  }
  return JSON.stringify(canonical) === snapshot.receiptText ? canonical : null
}

function storedReceipt(result: PromotionResult): StoredReceipt {
  if (!result.completedAt || !result.previousDeploymentId) {
    throw new SafetyError(
      "RECEIPT_INVALID",
      "A completed promotion receipt is missing required fields."
    )
  }
  return {
    version: 1,
    operationId: result.operationId,
    status: "promoted",
    teamId: result.teamId,
    projectId: result.projectId,
    deploymentId: result.deploymentId,
    previousDeploymentId: result.previousDeploymentId,
    gitSha: result.gitSha,
    approvalFingerprint: result.approvalFingerprint,
    verifiedAt: result.completedAt,
  }
}

export async function writePromotionReceipt(
  notion: NotionClientLike,
  input: PromoteInput,
  receiptProperty: string,
  result: PromotionResult
): Promise<"written" | "already_written"> {
  const snapshot = await retrieveApproval(
    notion,
    input.approvalPageId,
    receiptProperty
  )
  // A receipt-only resume may observe a changed page revision after an earlier
  // successful write, but the approved fields themselves must remain immutable.
  verifyApproval(snapshot, input, { requireRevision: false })
  const receipt = storedReceipt(result)
  const encoded = JSON.stringify(receipt)
  if (encoded.length > 1_900) {
    throw new SafetyError(
      "RECEIPT_TOO_LARGE",
      "The compact promotion receipt exceeds the Notion rich-text bound."
    )
  }

  if (snapshot.receiptText) {
    if (matchingStoredReceipt(snapshot, input, result.operationId)) {
      return "already_written"
    }
    throw new SafetyError(
      "RECEIPT_OCCUPIED",
      `${JSON.stringify(receiptProperty)} contains non-matching content or a receipt for another operation.`
    )
  }

  await notionRequest(() =>
    notion.pages.update({
      page_id: input.approvalPageId,
      properties: {
        [receiptProperty]: {
          rich_text: [
            {
              type: "text",
              text: { content: encoded },
            },
          ],
        },
      },
    })
  )
  const readback = await retrieveApproval(
    notion,
    input.approvalPageId,
    receiptProperty
  )
  verifyApproval(readback, input, { requireRevision: true })
  if (!matchingStoredReceipt(readback, input, result.operationId)) {
    throw new SafetyError(
      "RECEIPT_READBACK_FAILED",
      "Notion did not return the exact receipt after writeback."
    )
  }
  return "written"
}
