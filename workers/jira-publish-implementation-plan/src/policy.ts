import { createHash } from "node:crypto"

import type {
  PlanDependency,
  PlanNode,
  ProjectPolicy,
  PublishImplementationPlanInput,
  PublishReceipt,
} from "./types.js"

export const MAX_NODES = 15
export const MAX_DEPENDENCIES = 30
export const MAX_HIERARCHY_DEPTH = 2
export const MAX_LABELS_PER_NODE = 10
export const MAX_UNIQUE_ASSIGNEES = 10
export const MAX_SUMMARY_BYTES = 180
export const MAX_DESCRIPTION_BYTES = 4_000
export const MAX_CANONICAL_PLAN_BYTES = 80_000
export const MAX_RETRY_AFTER_SECONDS = 86_400

const SHA256 = /^[a-f0-9]{64}$/
const PAGE_ID =
  /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,19}$/
const NODE_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/
const NUMERIC_ID = /^[1-9][0-9]{0,31}$/
const SAFE_FIELD_ID = /^(?:[a-z][a-z0-9_]{0,63}|customfield_[1-9][0-9]{0,15})$/

export class PolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PolicyError"
  }
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

export function normalizePageId(value: string): string {
  const compact = value.trim().replaceAll("-", "").toLowerCase()
  if (!PAGE_ID.test(value.trim()) || compact.length !== 32) {
    throw new PolicyError("approvalPageId must be a Notion page UUID")
  }
  return compact
}

export function normalizeProjectKey(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (!PROJECT_KEY.test(normalized)) {
    throw new PolicyError("projectKey must be a Jira project key")
  }
  return normalized
}

export function assertSafeFieldId(value: string, name: string): string {
  const normalized = value.trim()
  if (!SAFE_FIELD_ID.test(normalized)) {
    throw new PolicyError(`${name} is not a safe Jira field ID`)
  }
  return normalized
}

function exactKeys(value: object, expected: string[], name: string): void {
  if (
    Object.keys(value).sort().join("\u0000") !==
    [...expected].sort().join("\u0000")
  ) {
    throw new PolicyError(`${name} contains unsupported fields`)
  }
}

function boundedText(
  name: string,
  value: string,
  maxBytes: number,
  options: { empty?: boolean; multiline?: boolean } = {}
): void {
  const bytes = Buffer.byteLength(value, "utf8")
  if ((!options.empty && bytes === 0) || bytes > maxBytes) {
    throw new PolicyError(
      `${name} must be ${options.empty ? "0" : "1"}-${maxBytes} UTF-8 bytes`
    )
  }
  const forbidden = options.multiline
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
    : /[\u0000-\u001f\u007f]/
  if (forbidden.test(value)) {
    throw new PolicyError(`${name} contains control characters`)
  }
}

function canonicalNode(node: PlanNode): PlanNode {
  return {
    nodeKey: node.nodeKey,
    issueTypeId: node.issueTypeId,
    parentNodeKey: node.parentNodeKey,
    summary: node.summary,
    description: node.description,
    assigneeAccountId: node.assigneeAccountId,
    labels: [...node.labels].sort(compare),
    estimatePoints: node.estimatePoints,
    sprintId: node.sprintId,
    fixVersionId: node.fixVersionId,
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function canonicalPlan(input: PublishImplementationPlanInput): string {
  return JSON.stringify({
    version: 1,
    projectKey: normalizeProjectKey(input.projectKey),
    nodes: input.nodes
      .map(canonicalNode)
      .sort((a, b) => compare(a.nodeKey, b.nodeKey)),
    dependencies: input.dependencies
      .map(({ blockerNodeKey, blockedNodeKey }) => ({
        blockerNodeKey,
        blockedNodeKey,
      }))
      .sort((a, b) =>
        compare(
          `${a.blockerNodeKey}>${a.blockedNodeKey}`,
          `${b.blockerNodeKey}>${b.blockedNodeKey}`
        )
      ),
  })
}

function validateNode(node: PlanNode, policy: ProjectPolicy): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new PolicyError("nodes must contain objects")
  }
  exactKeys(
    node,
    [
      "nodeKey",
      "issueTypeId",
      "parentNodeKey",
      "summary",
      "description",
      "assigneeAccountId",
      "labels",
      "estimatePoints",
      "sprintId",
      "fixVersionId",
    ],
    `node ${node.nodeKey || "<unknown>"}`
  )
  if (!NODE_KEY.test(node.nodeKey)) {
    throw new PolicyError("nodeKey must match the bounded lowercase key format")
  }
  if (!NUMERIC_ID.test(node.issueTypeId)) {
    throw new PolicyError(`${node.nodeKey}: issueTypeId must be numeric`)
  }
  if (!policy.issueTypeIds.has(node.issueTypeId)) {
    throw new PolicyError(`${node.nodeKey}: issue type is not allowlisted`)
  }
  if (node.parentNodeKey !== null && !NODE_KEY.test(node.parentNodeKey)) {
    throw new PolicyError(`${node.nodeKey}: parentNodeKey is invalid`)
  }
  boundedText(`${node.nodeKey}.summary`, node.summary, MAX_SUMMARY_BYTES)
  boundedText(
    `${node.nodeKey}.description`,
    node.description,
    MAX_DESCRIPTION_BYTES,
    { empty: true, multiline: true }
  )
  if (
    node.assigneeAccountId !== null &&
    (!policy.assigneeAccountIds.has(node.assigneeAccountId) ||
      Buffer.byteLength(node.assigneeAccountId, "utf8") > 128 ||
      /[\u0000-\u001f\u007f]/.test(node.assigneeAccountId))
  ) {
    throw new PolicyError(`${node.nodeKey}: assignee is not allowlisted`)
  }
  if (
    !Array.isArray(node.labels) ||
    node.labels.length > MAX_LABELS_PER_NODE ||
    new Set(node.labels).size !== node.labels.length
  ) {
    throw new PolicyError(`${node.nodeKey}: labels are invalid or duplicated`)
  }
  for (const label of node.labels) {
    boundedText(`${node.nodeKey}.labels[]`, label, 64)
    if (!policy.labels.has(label)) {
      throw new PolicyError(`${node.nodeKey}: label is not allowlisted`)
    }
  }
  if (
    node.estimatePoints !== null &&
    (!Number.isSafeInteger(node.estimatePoints) ||
      node.estimatePoints < 0 ||
      node.estimatePoints > 100 ||
      policy.fieldIds.estimate === null)
  ) {
    throw new PolicyError(`${node.nodeKey}: estimate is unsupported or invalid`)
  }
  if (
    node.sprintId !== null &&
    (!Number.isSafeInteger(node.sprintId) ||
      !policy.sprintIds.has(node.sprintId) ||
      policy.fieldIds.sprint === null)
  ) {
    throw new PolicyError(`${node.nodeKey}: sprint is not allowlisted`)
  }
  if (
    node.fixVersionId !== null &&
    (!NUMERIC_ID.test(node.fixVersionId) ||
      !policy.fixVersionIds.has(node.fixVersionId))
  ) {
    throw new PolicyError(`${node.nodeKey}: fix version is not allowlisted`)
  }
}

function assertAcyclic(
  keys: string[],
  edges: Array<[string, string]>,
  label: string
): void {
  const outgoing = new Map(keys.map((key) => [key, [] as string[]]))
  const indegree = new Map(keys.map((key) => [key, 0]))
  for (const [from, to] of edges) {
    outgoing.get(from)?.push(to)
    indegree.set(to, (indegree.get(to) ?? 0) + 1)
  }
  const queue = keys.filter((key) => indegree.get(key) === 0).sort(compare)
  let visited = 0
  while (queue.length > 0) {
    const current = queue.shift() as string
    visited += 1
    for (const next of outgoing.get(current) ?? []) {
      const value = (indegree.get(next) ?? 0) - 1
      indegree.set(next, value)
      if (value === 0) {
        queue.push(next)
        queue.sort(compare)
      }
    }
  }
  if (visited !== keys.length)
    throw new PolicyError(`${label} contains a cycle`)
}

function validateGraph(
  nodes: PlanNode[],
  dependencies: PlanDependency[],
  policy: ProjectPolicy
): void {
  const byKey = new Map(nodes.map((node) => [node.nodeKey, node]))
  if (byKey.size !== nodes.length)
    throw new PolicyError("nodeKey values must be unique")

  const hierarchyEdges: Array<[string, string]> = []
  for (const node of nodes) {
    if (node.parentNodeKey === null) continue
    const parent = byKey.get(node.parentNodeKey)
    if (!parent)
      throw new PolicyError(`${node.nodeKey}: parent node is missing`)
    if (parent.nodeKey === node.nodeKey) {
      throw new PolicyError(`${node.nodeKey}: a node cannot parent itself`)
    }
    if (
      !policy.parentTypePairs.has(`${parent.issueTypeId}>${node.issueTypeId}`)
    ) {
      throw new PolicyError(
        `${node.nodeKey}: parent/child issue-type pair is not allowlisted`
      )
    }
    hierarchyEdges.push([parent.nodeKey, node.nodeKey])
  }
  assertAcyclic([...byKey.keys()], hierarchyEdges, "hierarchy")

  for (const node of nodes) {
    let depth = 0
    let current = node
    while (current.parentNodeKey !== null) {
      depth += 1
      current = byKey.get(current.parentNodeKey) as PlanNode
    }
    if (depth > MAX_HIERARCHY_DEPTH) {
      throw new PolicyError(
        `${node.nodeKey}: hierarchy exceeds ${MAX_HIERARCHY_DEPTH} parent edges`
      )
    }
  }

  const seen = new Set<string>()
  const dependencyEdges: Array<[string, string]> = []
  for (const dependency of dependencies) {
    if (
      !dependency ||
      typeof dependency !== "object" ||
      Array.isArray(dependency)
    ) {
      throw new PolicyError("dependencies must contain objects")
    }
    exactKeys(dependency, ["blockerNodeKey", "blockedNodeKey"], "dependency")
    if (
      !byKey.has(dependency.blockerNodeKey) ||
      !byKey.has(dependency.blockedNodeKey)
    ) {
      throw new PolicyError("dependency references an unknown node")
    }
    if (dependency.blockerNodeKey === dependency.blockedNodeKey) {
      throw new PolicyError("a node cannot block itself")
    }
    const key = `${dependency.blockerNodeKey}>${dependency.blockedNodeKey}`
    if (seen.has(key)) throw new PolicyError(`duplicate dependency: ${key}`)
    seen.add(key)
    dependencyEdges.push([dependency.blockerNodeKey, dependency.blockedNodeKey])
  }
  assertAcyclic([...byKey.keys()], dependencyEdges, "dependency graph")
}

export function validateInput(
  input: PublishImplementationPlanInput,
  policy: ProjectPolicy
): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PolicyError("input must be an object")
  }
  exactKeys(
    input,
    [
      "approvalPageId",
      "approvalRevision",
      "planHash",
      "projectKey",
      "nodes",
      "dependencies",
    ],
    "input"
  )
  normalizePageId(input.approvalPageId)
  boundedText("approvalRevision", input.approvalRevision, 160)
  if (!SHA256.test(input.planHash)) {
    throw new PolicyError("planHash must be lowercase SHA-256")
  }
  if (normalizeProjectKey(input.projectKey) !== policy.projectKey) {
    throw new PolicyError("projectKey does not match the selected policy")
  }
  if (
    !Array.isArray(input.nodes) ||
    input.nodes.length < 1 ||
    input.nodes.length > MAX_NODES
  ) {
    throw new PolicyError(`nodes must contain 1-${MAX_NODES} complete nodes`)
  }
  if (
    !Array.isArray(input.dependencies) ||
    input.dependencies.length > MAX_DEPENDENCIES
  ) {
    throw new PolicyError(
      `dependencies must contain at most ${MAX_DEPENDENCIES} edges`
    )
  }
  for (const node of input.nodes) validateNode(node, policy)
  if (
    new Set(
      input.nodes
        .map((node) => node.assigneeAccountId)
        .filter((value): value is string => value !== null)
    ).size > MAX_UNIQUE_ASSIGNEES
  ) {
    throw new PolicyError(
      `plan may use at most ${MAX_UNIQUE_ASSIGNEES} unique assignees`
    )
  }
  validateGraph(input.nodes, input.dependencies, policy)
  if (
    Buffer.byteLength(canonicalPlan(input), "utf8") > MAX_CANONICAL_PLAN_BYTES
  ) {
    throw new PolicyError(
      `canonical plan exceeds ${MAX_CANONICAL_PLAN_BYTES} UTF-8 bytes`
    )
  }
  if (sha256(canonicalPlan(input)) !== input.planHash) {
    throw new PolicyError("planHash does not match the canonical complete plan")
  }
}

export function stableNodeOrder(nodes: PlanNode[]): PlanNode[] {
  const byKey = new Map(nodes.map((node) => [node.nodeKey, node]))
  const depth = (node: PlanNode): number => {
    let result = 0
    let current = node
    while (current.parentNodeKey !== null) {
      result += 1
      current = byKey.get(current.parentNodeKey) as PlanNode
    }
    return result
  }
  return [...nodes].sort(
    (left, right) =>
      depth(left) - depth(right) || compare(left.nodeKey, right.nodeKey)
  )
}

export function buildProviderPolicyFingerprint(options: {
  cloudId: string
  siteUrl: string
  dependencyLinkTypeId: string
  dependencyLinkTypeName: string
  project: ProjectPolicy
}): string {
  const project = options.project
  return sha256(
    JSON.stringify({
      version: 1,
      cloudId: options.cloudId.toLowerCase(),
      siteUrl: options.siteUrl.toLowerCase().replace(/\/$/, ""),
      dependencyLinkTypeId: options.dependencyLinkTypeId,
      dependencyLinkTypeName: options.dependencyLinkTypeName,
      project: {
        projectKey: project.projectKey,
        projectId: project.projectId,
        issueTypeIds: [...project.issueTypeIds].sort(compare),
        parentTypePairs: [...project.parentTypePairs].sort(compare),
        assigneeAccountIds: [...project.assigneeAccountIds].sort(compare),
        labels: [...project.labels].sort(compare),
        fixVersionIds: [...project.fixVersionIds].sort(compare),
        sprintIds: [...project.sprintIds].sort((left, right) => left - right),
        fieldIds: {
          estimate: project.fieldIds.estimate,
          sprint: project.fieldIds.sprint,
        },
      },
    })
  )
}

export function buildIdentity(
  input: PublishImplementationPlanInput,
  providerPolicyFingerprint: string
): {
  idempotencyKey: string
  operationId: string
  publicationKey: string
} {
  if (!SHA256.test(providerPolicyFingerprint)) {
    throw new PolicyError(
      "provider policy fingerprint must be lowercase SHA-256"
    )
  }
  const pageId = normalizePageId(input.approvalPageId)
  const projectKey = normalizeProjectKey(input.projectKey)
  const digest = sha256(
    [
      "jira-plan-v1",
      pageId,
      input.approvalRevision,
      input.planHash,
      projectKey,
      providerPolicyFingerprint,
    ].join(":")
  )
  return {
    idempotencyKey: `jira-plan:${digest}`,
    operationId: `jplan_${digest.slice(0, 24)}`,
    publicationKey: `source:${pageId}:project:${projectKey}`,
  }
}

export function nodeMarker(operationId: string, nodeKey: string): string {
  return `ntn-${operationId.slice(6, 22)}-${sha256(nodeKey).slice(0, 8)}`
}

export function boundedRetryAfterSeconds(
  value: number | null | undefined
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value))
    return null
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(0, Math.ceil(value)))
}

export function assertReceipt(receipt: PublishReceipt): void {
  const validStatuses = new Set([
    "completed",
    "no_op",
    "blocked",
    "conflict",
    "partial_failure",
    "ambiguous",
  ])
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    !exactReceiptKeys(receipt, [
      "ok",
      "status",
      "operationId",
      "idempotencyKey",
      "changed",
      "replay",
      "projectKey",
      "planHash",
      "approvalPageId",
      "approvalRevision",
      "providerPolicyFingerprint",
      "startedAt",
      "completedAt",
      "nodes",
      "dependencies",
      "notionReceiptWritten",
      "steps",
      "warnings",
      "retryable",
      "retryAfterSeconds",
      "repair",
    ]) ||
    !validStatuses.has(receipt.status) ||
    receipt.ok !== ["completed", "no_op"].includes(receipt.status) ||
    (receipt.status === "completed" && !receipt.changed) ||
    (receipt.status === "no_op" && receipt.changed) ||
    receipt.replay !== (receipt.status === "no_op") ||
    !/^jplan_[a-f0-9]{24}$/.test(receipt.operationId) ||
    !/^jira-plan:[a-f0-9]{64}$/.test(receipt.idempotencyKey) ||
    !PROJECT_KEY.test(receipt.projectKey) ||
    !SHA256.test(receipt.planHash) ||
    !PAGE_ID.test(receipt.approvalPageId) ||
    typeof receipt.approvalRevision !== "string" ||
    receipt.approvalRevision.length < 1 ||
    receipt.approvalRevision.length > 160 ||
    !SHA256.test(receipt.providerPolicyFingerprint) ||
    Number.isNaN(Date.parse(receipt.startedAt)) ||
    (receipt.completedAt !== null &&
      Number.isNaN(Date.parse(receipt.completedAt))) ||
    ["completed", "no_op"].includes(receipt.status) !==
      (receipt.completedAt !== null) ||
    (["completed", "no_op"].includes(receipt.status) &&
      !receipt.notionReceiptWritten) ||
    (!["completed", "no_op", "partial_failure"].includes(receipt.status) &&
      receipt.notionReceiptWritten) ||
    !Array.isArray(receipt.nodes) ||
    receipt.nodes.length > MAX_NODES ||
    !Array.isArray(receipt.dependencies) ||
    receipt.dependencies.length > MAX_DEPENDENCIES ||
    !Array.isArray(receipt.steps) ||
    receipt.steps.length > 10 ||
    !Array.isArray(receipt.warnings) ||
    receipt.warnings.length > 5 ||
    typeof receipt.retryable !== "boolean" ||
    (receipt.retryAfterSeconds !== null &&
      (!Number.isSafeInteger(receipt.retryAfterSeconds) ||
        receipt.retryAfterSeconds < 0 ||
        receipt.retryAfterSeconds > MAX_RETRY_AFTER_SECONDS)) ||
    (receipt.repair !== null && receipt.repair.length > 500)
  ) {
    throw new Error("invalid publishImplementationPlan receipt")
  }

  const nodeKeys = new Set<string>()
  for (const node of receipt.nodes) {
    const hasIdentity = node.issueId !== null
    if (
      !node ||
      typeof node !== "object" ||
      Array.isArray(node) ||
      !exactReceiptKeys(node, [
        "nodeKey",
        "issueId",
        "issueKey",
        "url",
        "action",
      ]) ||
      !NODE_KEY.test(node.nodeKey) ||
      nodeKeys.has(node.nodeKey) ||
      !["created", "existing", "failed", "unknown"].includes(node.action) ||
      hasIdentity !== (node.issueKey !== null) ||
      hasIdentity !== (node.url !== null) ||
      ["created", "existing"].includes(node.action) !== hasIdentity
    ) {
      throw new Error("receipt contains an invalid node record")
    }
    if (hasIdentity) {
      if (
        typeof node.issueId !== "string" ||
        !NUMERIC_ID.test(node.issueId) ||
        typeof node.issueKey !== "string" ||
        !node.issueKey.startsWith(`${receipt.projectKey}-`) ||
        typeof node.url !== "string"
      ) {
        throw new Error("receipt node identity is invalid")
      }
      try {
        const url = new URL(node.url)
        if (
          url.protocol !== "https:" ||
          !url.hostname.endsWith(".atlassian.net") ||
          !url.pathname.startsWith("/browse/") ||
          url.username !== "" ||
          url.password !== ""
        ) {
          throw new Error("unsafe")
        }
      } catch {
        throw new Error("receipt node URL is invalid")
      }
    }
    nodeKeys.add(node.nodeKey)
  }

  const dependencyKeys = new Set<string>()
  for (const dependency of receipt.dependencies) {
    const key = `${dependency.blockerNodeKey}>${dependency.blockedNodeKey}`
    if (
      !dependency ||
      typeof dependency !== "object" ||
      Array.isArray(dependency) ||
      !exactReceiptKeys(dependency, [
        "blockerNodeKey",
        "blockedNodeKey",
        "action",
      ]) ||
      !nodeKeys.has(dependency.blockerNodeKey) ||
      !nodeKeys.has(dependency.blockedNodeKey) ||
      dependencyKeys.has(key) ||
      !["created", "existing", "failed", "unknown"].includes(dependency.action)
    ) {
      throw new Error("receipt contains an invalid dependency record")
    }
    dependencyKeys.add(key)
  }

  const stepNames = new Set([
    "approval",
    "claim",
    "metadata",
    "nodes",
    "dependencies",
    "notion_receipt",
  ])
  if (
    receipt.steps.some(
      (step) =>
        !step ||
        typeof step !== "object" ||
        Array.isArray(step) ||
        !exactReceiptKeys(step, ["name", "status", "detail"]) ||
        !stepNames.has(step.name) ||
        !["completed", "skipped", "failed", "unknown"].includes(step.status) ||
        typeof step.detail !== "string" ||
        step.detail.length > 300
    )
  ) {
    throw new Error("receipt contains an invalid step")
  }
  if (
    receipt.warnings.some(
      (warning) =>
        typeof warning !== "string" ||
        warning.length > 500 ||
        /[\u0000-\u001f\u007f]/.test(warning)
    )
  ) {
    throw new Error("receipt contains an invalid warning")
  }
  if (JSON.stringify(receipt).length > 20_000) {
    throw new Error("receipt exceeds output bound")
  }
}

function exactReceiptKeys(value: object, expected: string[]): boolean {
  return (
    Object.keys(value).sort().join("\u0000") ===
    [...expected].sort().join("\u0000")
  )
}
