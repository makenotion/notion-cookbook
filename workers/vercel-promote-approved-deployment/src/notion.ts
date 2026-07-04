import { createHash } from "node:crypto"
import { DEPLOYMENT_ID, GIT_SHA, PROJECT_ID, TEAM_ID } from "./config.js"
import {
  type ApprovalAction,
  type ApprovalSnapshot,
  type NotionClientLike,
  SafetyError,
  type TransitionAction,
  type TransitionReceipt,
} from "./types.js"

export const APPROVAL_PROPERTIES = {
  status: "Approval status",
  action: "Action",
  revision: "Approval revision",
  teamId: "Vercel team ID",
  projectId: "Vercel project ID",
  targetDeploymentId: "Target deployment ID",
  currentDeploymentId: "Expected current deployment ID",
  gitSha: "Git SHA",
  receipt: "Worker receipt",
} as const

type ReceiptState = TransitionReceipt["state"]
type SnapshotFields = Omit<ApprovalSnapshot, "operationId" | "receipt">

const MAX_RECEIPT_LENGTH = 1_900
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PARENT_ID =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
const OPERATION_ID = /^(?:vpa|vrb)_[0-9a-f]{32}$/
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

function fail(code: string, message: string): never {
  throw new SafetyError(code, message)
}

function record(value: unknown, code = "APPROVAL_SCHEMA") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code, "Notion returned invalid approval data.")
  }
  return value as Record<string, unknown>
}

function normalizeId(value: string): string {
  return value.replaceAll("-", "").toLowerCase()
}

function validIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false
  const timestamp = Date.parse(value)
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  )
}

function assertParent(page: Record<string, unknown>, expectedId: string): void {
  if (!PARENT_ID.test(expectedId)) {
    fail("INVALID_PARENT_ID", "The configured approval parent ID is invalid.")
  }
  const parent = record(page.parent, "APPROVAL_PARENT_MISMATCH")
  const actualIds =
    parent.type === "data_source_id"
      ? [parent.data_source_id, parent.database_id]
      : parent.type === "database_id"
        ? [parent.database_id]
        : []
  if (
    !actualIds.some(
      (actualId) =>
        typeof actualId === "string" &&
        normalizeId(actualId) === normalizeId(expectedId)
    )
  ) {
    fail(
      "APPROVAL_PARENT_MISMATCH",
      "The approval must belong to the configured Notion data source."
    )
  }
}

function textProperty(
  properties: Record<string, unknown>,
  name: string,
  maximum: number
): string {
  const property = record(properties[name])
  if (property.type !== "rich_text" && property.type !== "title") {
    fail(
      "APPROVAL_SCHEMA",
      `${JSON.stringify(name)} must be rich text or a title.`
    )
  }
  const fragments = property[property.type]
  if (!Array.isArray(fragments)) {
    fail("APPROVAL_SCHEMA", `${JSON.stringify(name)} has an invalid value.`)
  }
  let value = ""
  for (const fragment of fragments) {
    const plainText = record(fragment).plain_text
    if (typeof plainText !== "string") {
      fail("APPROVAL_SCHEMA", `${JSON.stringify(name)} has invalid text.`)
    }
    value += plainText
    if (value.length > maximum) {
      fail("APPROVAL_SCHEMA", `${JSON.stringify(name)} is too long.`)
    }
  }
  if (!value || value.trim() !== value || CONTROL_CHARACTER.test(value)) {
    fail(
      "APPROVAL_SCHEMA",
      `${JSON.stringify(name)} must be exact, non-empty text.`
    )
  }
  return value
}

function selectedName(
  properties: Record<string, unknown>,
  name: string
): string {
  const property = record(properties[name])
  const option =
    property.type === "status"
      ? property.status
      : property.type === "select"
        ? property.select
        : null
  const value = record(option).name
  if (
    typeof value !== "string" ||
    value.length > 32 ||
    CONTROL_CHARACTER.test(value)
  ) {
    fail("APPROVAL_SCHEMA", `${JSON.stringify(name)} has an invalid value.`)
  }
  return value
}

function readReceiptText(properties: Record<string, unknown>): string {
  const property = record(properties[APPROVAL_PROPERTIES.receipt])
  if (property.type !== "rich_text" || !Array.isArray(property.rich_text)) {
    fail("APPROVAL_SCHEMA", '"Worker receipt" must be rich text.')
  }
  let value = ""
  for (const fragment of property.rich_text) {
    const plainText = record(fragment, "RECEIPT_INVALID").plain_text
    if (typeof plainText !== "string") {
      fail("RECEIPT_INVALID", "The Worker receipt has invalid text.")
    }
    value += plainText
    if (value.length > MAX_RECEIPT_LENGTH) {
      fail("RECEIPT_INVALID", "The Worker receipt is too long.")
    }
  }
  return value
}

/** Canonical transition identity excludes the page and revision so a replacement
 * approval for the same traffic change receives the same operation ID. */
export function canonicalApprovalJson(approval: SnapshotFields): string {
  return JSON.stringify({
    version: 1,
    action: approval.action,
    teamId: approval.teamId,
    projectId: approval.projectId,
    expectedCurrentDeploymentId: approval.expectedCurrentDeploymentId,
    targetDeploymentId: approval.targetDeploymentId,
    gitSha: approval.gitSha,
  })
}

export function approvalOperationId(approval: SnapshotFields): string {
  const digest = createHash("sha256")
    .update(canonicalApprovalJson(approval))
    .digest("hex")
    .slice(0, 32)
  return `${approval.action === "Promote" ? "vpa" : "vrb"}_${digest}`
}

export function canonicalReceiptJson(receipt: TransitionReceipt): string {
  const encoded = JSON.stringify({
    version: 1,
    operationId: receipt.operationId,
    state: receipt.state,
    action: receipt.action,
    approvalRevision: receipt.approvalRevision,
    targetDeploymentId: receipt.targetDeploymentId,
    updatedAt: receipt.updatedAt,
  })
  if (encoded.length > MAX_RECEIPT_LENGTH) {
    fail("RECEIPT_INVALID", "The Worker receipt is too long.")
  }
  return encoded
}

function exactReceiptKeys(value: Record<string, unknown>): void {
  const expected = [
    "version",
    "operationId",
    "state",
    "action",
    "approvalRevision",
    "targetDeploymentId",
    "updatedAt",
  ].sort()
  const actual = Object.keys(value).sort()
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail("RECEIPT_INVALID", "The Worker receipt has unexpected fields.")
  }
}

export function parseMatchingReceipt(
  raw: string,
  approval: Omit<ApprovalSnapshot, "receipt">
): TransitionReceipt | null {
  if (!raw) return null
  if (raw.length > MAX_RECEIPT_LENGTH) {
    fail("RECEIPT_INVALID", "The Worker receipt is too long.")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail("RECEIPT_INVALID", "The Worker receipt is not valid JSON.")
  }
  const value = record(parsed, "RECEIPT_INVALID")
  exactReceiptKeys(value)
  if (
    value.version !== 1 ||
    !OPERATION_ID.test(String(value.operationId)) ||
    (value.action !== "Promote" && value.action !== "Rollback") ||
    (value.state !== "request_started" &&
      value.state !== "completed" &&
      value.state !== "rejected" &&
      value.state !== "cancelled") ||
    typeof value.approvalRevision !== "string" ||
    typeof value.targetDeploymentId !== "string" ||
    !validIsoTimestamp(value.updatedAt)
  ) {
    fail("RECEIPT_INVALID", "The Worker receipt has invalid fields.")
  }
  const receipt = value as unknown as TransitionReceipt
  if (
    receipt.operationId !== approval.operationId ||
    receipt.action !== approval.action ||
    receipt.approvalRevision !== approval.revision ||
    receipt.targetDeploymentId !== approval.targetDeploymentId ||
    canonicalReceiptJson(receipt) !== raw
  ) {
    fail("RECEIPT_MISMATCH", "The Worker receipt does not match this approval.")
  }
  return receipt
}

export function createReceipt(
  approval: Omit<ApprovalSnapshot, "receipt">,
  state: ReceiptState,
  now: Date = new Date()
): TransitionReceipt {
  return {
    version: 1,
    operationId: approval.operationId,
    state,
    action: approval.action,
    approvalRevision: approval.revision,
    targetDeploymentId: approval.targetDeploymentId,
    updatedAt: now.toISOString(),
  }
}

export async function readApproval(
  notion: NotionClientLike,
  options: {
    pageId: string
    parentId: string
    expectedAction: TransitionAction
  }
): Promise<ApprovalSnapshot> {
  if (!UUID.test(options.pageId)) {
    fail("INVALID_PAGE_ID", "The approval page ID must be a UUID.")
  }
  const page = record(
    await notion.pages.retrieve({ page_id: options.pageId }),
    "APPROVAL_NOT_FOUND"
  )
  if (
    page.object !== "page" ||
    page.archived === true ||
    page.in_trash === true ||
    typeof page.id !== "string" ||
    normalizeId(page.id) !== normalizeId(options.pageId)
  ) {
    fail("APPROVAL_INACTIVE", "The approval page is inactive or mismatched.")
  }
  assertParent(page, options.parentId)
  const properties = record(page.properties)
  if (selectedName(properties, APPROVAL_PROPERTIES.status) !== "Approved") {
    fail("NOT_APPROVED", 'Approval status must be exactly "Approved".')
  }
  const actionName = selectedName(properties, APPROVAL_PROPERTIES.action)
  if (actionName !== "Promote" && actionName !== "Rollback") {
    fail("APPROVAL_SCHEMA", 'Action must be "Promote" or "Rollback".')
  }
  const action: ApprovalAction = actionName
  const expectedAction: ApprovalAction =
    options.expectedAction === "promote" ? "Promote" : "Rollback"
  if (action !== expectedAction) {
    fail(
      "ACTION_MISMATCH",
      `This tool requires a ${options.expectedAction} approval.`
    )
  }
  const base = {
    pageId: options.pageId,
    action,
    revision: textProperty(properties, APPROVAL_PROPERTIES.revision, 100),
    teamId: textProperty(properties, APPROVAL_PROPERTIES.teamId, 100),
    projectId: textProperty(properties, APPROVAL_PROPERTIES.projectId, 100),
    expectedCurrentDeploymentId: textProperty(
      properties,
      APPROVAL_PROPERTIES.currentDeploymentId,
      100
    ),
    targetDeploymentId: textProperty(
      properties,
      APPROVAL_PROPERTIES.targetDeploymentId,
      100
    ),
    gitSha: textProperty(properties, APPROVAL_PROPERTIES.gitSha, 64),
  } satisfies SnapshotFields
  if (!TEAM_ID.test(base.teamId) || !PROJECT_ID.test(base.projectId)) {
    fail("APPROVAL_SCHEMA", "The Vercel team or project ID is invalid.")
  }
  if (
    !DEPLOYMENT_ID.test(base.expectedCurrentDeploymentId) ||
    !DEPLOYMENT_ID.test(base.targetDeploymentId)
  ) {
    fail("APPROVAL_SCHEMA", "A deployment ID is invalid.")
  }
  if (!GIT_SHA.test(base.gitSha)) {
    fail("APPROVAL_SCHEMA", "Git SHA must be a full lowercase SHA.")
  }
  const approval = {
    ...base,
    operationId: approvalOperationId(base),
  }
  return {
    ...approval,
    receipt: parseMatchingReceipt(readReceiptText(properties), approval),
  }
}

function receiptTransition(
  existing: TransitionReceipt | null,
  next: TransitionReceipt
): "write" | "already_written" {
  if (!existing) return "write"
  if (canonicalReceiptJson(existing) === canonicalReceiptJson(next)) {
    return "already_written"
  }
  const allowed =
    existing.state === "request_started" &&
    (next.state === "completed" ||
      next.state === "rejected" ||
      next.state === "cancelled")
  if (!allowed || Date.parse(next.updatedAt) < Date.parse(existing.updatedAt)) {
    fail("RECEIPT_CONFLICT", "The requested receipt transition is not allowed.")
  }
  return "write"
}

export async function writeReceipt(
  notion: NotionClientLike,
  options: {
    pageId: string
    parentId: string
    expectedAction: TransitionAction
    receipt: TransitionReceipt
  }
): Promise<"written" | "already_written"> {
  const approval = await readApproval(notion, options)
  if (options.receipt.operationId !== approvalOperationId(approval)) {
    fail("RECEIPT_MISMATCH", "The receipt does not match this approval.")
  }
  parseMatchingReceipt(canonicalReceiptJson(options.receipt), approval)
  if (
    receiptTransition(approval.receipt, options.receipt) === "already_written"
  ) {
    return "already_written"
  }
  const encoded = canonicalReceiptJson(options.receipt)
  await notion.pages.update({
    page_id: options.pageId,
    properties: {
      [APPROVAL_PROPERTIES.receipt]: {
        rich_text: [{ type: "text", text: { content: encoded } }],
      },
    },
  })
  const readback = await readApproval(notion, options)
  if (!readback.receipt || canonicalReceiptJson(readback.receipt) !== encoded) {
    fail("RECEIPT_READBACK_FAILED", "Notion did not return the exact receipt.")
  }
  return "written"
}
