import { createHash } from "node:crypto"

import type {
  DraftNode,
  DraftPlan,
  JiraNamedRef,
  PlanDependency,
  PreparedNode,
  PreparedPlan,
  PreparedPlanData,
} from "./types.js"

export const MAX_CHILDREN = 10
export const MAX_DEPENDENCIES = 10
export const MAX_LABELS = 5
export const MAX_SUMMARY_BYTES = 180
export const MAX_DESCRIPTION_BYTES = 4_000
export const MAX_ACCEPTANCE_CRITERIA_BYTES = 4_000

const PAGE_ID =
  /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i
const CLIENT_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/
const NUMERIC_ID = /^[1-9][0-9]{0,31}$/
const CUSTOM_FIELD_ID = /^customfield_[1-9][0-9]{0,15}$/
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const PLAN_VERSION = /^sha256:[a-f0-9]{64}$/

export class PlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PlanError"
  }
}

export function normalizePageId(value: string): string {
  const trimmed = value.trim()
  const compact = trimmed.replaceAll("-", "").toLowerCase()
  if (!PAGE_ID.test(trimmed) || compact.length !== 32) {
    throw new PlanError("sourcePageId must be a Notion page UUID")
  }
  return compact
}

function boundedText(
  value: string,
  name: string,
  maxBytes: number,
  allowEmpty = false
): string {
  const normalized = value.trim()
  const bytes = Buffer.byteLength(normalized, "utf8")
  if ((!allowEmpty && bytes === 0) || bytes > maxBytes) {
    throw new PlanError(
      `${name} must be ${allowEmpty ? "0" : "1"}-${maxBytes} UTF-8 bytes`
    )
  }
  if (/[^\P{Cc}\n\t]/u.test(normalized)) {
    throw new PlanError(`${name} contains unsupported control characters`)
  }
  return normalized
}

function assertCanonicalText(
  value: string,
  name: string,
  maxBytes: number,
  allowEmpty = false
): void {
  if (boundedText(value, name, maxBytes, allowEmpty) !== value) {
    throw new PlanError(`${name} must not have surrounding whitespace`)
  }
}

function namedValue(value: string, name: string): string {
  return boundedText(value, name, 200)
}

function optionalNumericId(value: string | null, name: string): string | null {
  if (value === null) return null
  const normalized = value.trim()
  if (!NUMERIC_ID.test(normalized)) throw new PlanError(`${name} is invalid`)
  return normalized
}

function optionalAccountId(value: string | null, name: string): string | null {
  if (value === null) return null
  const normalized = value.trim()
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, "utf8") > 128 ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new PlanError(`${name} is invalid`)
  }
  return normalized
}

function normalizeNode(node: DraftNode, path: string): DraftNode {
  const clientKey = node.clientKey.trim().toLowerCase()
  if (!CLIENT_KEY.test(clientKey)) {
    throw new PlanError(`${path}.clientKey is invalid`)
  }
  const labels = node.labels.map((label) => label.trim()).sort()
  if (
    labels.length > MAX_LABELS ||
    new Set(labels).size !== labels.length ||
    labels.some(
      (label) =>
        !LABEL.test(label) || label.toLowerCase().startsWith("notion-page-")
    )
  ) {
    throw new PlanError(
      `${path}.labels must contain at most ${MAX_LABELS} unique Jira labels and cannot use the reserved notion-page- prefix`
    )
  }
  if (
    node.estimate !== null &&
    (!Number.isSafeInteger(node.estimate) ||
      node.estimate < 0 ||
      node.estimate > 100)
  ) {
    throw new PlanError(
      `${path}.estimate must be an integer from 0 to 100 or null`
    )
  }
  if (node.assigneeName === null && node.assigneeAccountId !== null) {
    throw new PlanError(`${path}.assigneeAccountId needs assigneeName`)
  }
  if (node.fixVersionName === null && node.fixVersionId !== null) {
    throw new PlanError(`${path}.fixVersionId needs fixVersionName`)
  }
  return {
    clientKey,
    summary: boundedText(node.summary, `${path}.summary`, MAX_SUMMARY_BYTES),
    description: boundedText(
      node.description,
      `${path}.description`,
      MAX_DESCRIPTION_BYTES,
      true
    ),
    acceptanceCriteria: boundedText(
      node.acceptanceCriteria,
      `${path}.acceptanceCriteria`,
      MAX_ACCEPTANCE_CRITERIA_BYTES,
      true
    ),
    issueTypeName: namedValue(node.issueTypeName, `${path}.issueTypeName`),
    issueTypeId: optionalNumericId(node.issueTypeId, `${path}.issueTypeId`),
    assigneeName:
      node.assigneeName === null
        ? null
        : namedValue(node.assigneeName, `${path}.assigneeName`),
    assigneeAccountId: optionalAccountId(
      node.assigneeAccountId,
      `${path}.assigneeAccountId`
    ),
    labels,
    estimate: node.estimate,
    fixVersionName:
      node.fixVersionName === null
        ? null
        : namedValue(node.fixVersionName, `${path}.fixVersionName`),
    fixVersionId: optionalNumericId(node.fixVersionId, `${path}.fixVersionId`),
  }
}

function dependencyOrder(left: PlanDependency, right: PlanDependency): number {
  return (
    left.blockerClientKey.localeCompare(right.blockerClientKey) ||
    left.blockedClientKey.localeCompare(right.blockedClientKey)
  )
}

function assertAcyclic(
  dependencies: PlanDependency[],
  keys: Set<string>
): void {
  const outgoing = new Map<string, string[]>()
  const indegree = new Map([...keys].map((key) => [key, 0]))
  for (const dependency of dependencies) {
    outgoing.set(dependency.blockerClientKey, [
      ...(outgoing.get(dependency.blockerClientKey) ?? []),
      dependency.blockedClientKey,
    ])
    indegree.set(
      dependency.blockedClientKey,
      (indegree.get(dependency.blockedClientKey) ?? 0) + 1
    )
  }
  const queue = [...keys].filter((key) => indegree.get(key) === 0).sort()
  let visited = 0
  while (queue.length > 0) {
    const current = queue.shift() as string
    visited += 1
    for (const next of outgoing.get(current) ?? []) {
      const value = (indegree.get(next) ?? 0) - 1
      indegree.set(next, value)
      if (value === 0) {
        queue.push(next)
        queue.sort()
      }
    }
  }
  if (visited !== keys.size) {
    throw new PlanError("dependencies contain a cycle")
  }
}

function normalizeDependencies(
  dependencies: PlanDependency[],
  childKeys: Set<string>
): PlanDependency[] {
  if (dependencies.length > MAX_DEPENDENCIES) {
    throw new PlanError(
      `dependencies must contain at most ${MAX_DEPENDENCIES} links`
    )
  }
  const result = dependencies
    .map((dependency, index) => {
      const blockerClientKey = dependency.blockerClientKey.trim().toLowerCase()
      const blockedClientKey = dependency.blockedClientKey.trim().toLowerCase()
      if (
        !childKeys.has(blockerClientKey) ||
        !childKeys.has(blockedClientKey)
      ) {
        throw new PlanError(
          `dependencies[${index}] must reference two child work items`
        )
      }
      if (blockerClientKey === blockedClientKey) {
        throw new PlanError(
          `dependencies[${index}] cannot link an item to itself`
        )
      }
      return { blockerClientKey, blockedClientKey }
    })
    .sort(dependencyOrder)
  const identities = result.map(
    (item) => `${item.blockerClientKey}\u0000${item.blockedClientKey}`
  )
  if (new Set(identities).size !== identities.length) {
    throw new PlanError("dependencies contain duplicates")
  }
  assertAcyclic(result, childKeys)
  return result
}

export function normalizeDraftPlan(input: DraftPlan): DraftPlan {
  if (input.children.length < 1 || input.children.length > MAX_CHILDREN) {
    throw new PlanError(`children must contain 1-${MAX_CHILDREN} work items`)
  }
  const epic = normalizeNode(input.epic, "epic")
  const children = input.children.map((node, index) =>
    normalizeNode(node, `children[${index}]`)
  )
  const allKeys = [epic.clientKey, ...children.map((node) => node.clientKey)]
  if (new Set(allKeys).size !== allKeys.length) {
    throw new PlanError("clientKey values must be unique")
  }
  const childKeys = new Set(children.map((node) => node.clientKey))
  return {
    sourcePageId: normalizePageId(input.sourcePageId),
    epic,
    children,
    dependencies: normalizeDependencies(input.dependencies, childKeys),
  }
}

export function preparedNodes(
  input: Pick<PreparedPlanData, "epic" | "children">
): PreparedNode[] {
  return [
    input.epic,
    ...[...input.children].sort((left, right) =>
      left.clientKey.localeCompare(right.clientKey)
    ),
  ]
}

function canonicalPreparedPlan(input: PreparedPlanData): string {
  const nodeValue = (node: PreparedNode) => [
    node.clientKey,
    node.summary,
    node.description,
    node.acceptanceCriteria,
    node.issueType.id,
    node.issueType.name,
    node.assignee ? [node.assignee.id, node.assignee.name] : null,
    [...node.labels].sort(),
    node.estimate,
    node.fixVersion ? [node.fixVersion.id, node.fixVersion.name] : null,
  ]
  const dependencies = [...input.dependencies].sort(dependencyOrder)
  return JSON.stringify([
    1,
    normalizePageId(input.source.pageId),
    input.source.url,
    input.source.lastEditedTime,
    input.project.id,
    input.project.key,
    input.project.url,
    input.project.name,
    input.blocksLinkType.id,
    input.blocksLinkType.name,
    input.blocksLinkType.outward,
    input.blocksLinkType.inward,
    input.estimateFieldId,
    nodeValue(input.epic),
    [...input.children]
      .sort((left, right) => left.clientKey.localeCompare(right.clientKey))
      .map(nodeValue),
    dependencies.map((item) => [item.blockerClientKey, item.blockedClientKey]),
  ])
}

export function buildPlanVersion(input: PreparedPlanData): string {
  return `sha256:${createHash("sha256")
    .update(canonicalPreparedPlan(input))
    .digest("hex")}`
}

function assertNamedRef(value: JiraNamedRef, name: string): void {
  if (!NUMERIC_ID.test(value.id)) throw new PlanError(`${name}.id is invalid`)
  assertCanonicalText(value.name, `${name}.name`, 200)
}

export function validatePreparedPlan(input: PreparedPlan): PreparedPlan {
  const pageId = normalizePageId(input.source.pageId)
  if (pageId !== input.source.pageId) {
    throw new PlanError("prepared source.pageId must be normalized")
  }
  assertCanonicalText(input.source.url, "source.url", 2_048)
  if (!input.source.url.startsWith("https://www.notion.so/")) {
    throw new PlanError("prepared source URL is invalid")
  }
  assertCanonicalText(input.source.lastEditedTime, "source.lastEditedTime", 100)
  if (Number.isNaN(Date.parse(input.source.lastEditedTime))) {
    throw new PlanError("prepared source lastEditedTime is invalid")
  }
  assertNamedRef(input.project, "project")
  if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(input.project.key)) {
    throw new PlanError("prepared project key is invalid")
  }
  assertCanonicalText(input.project.url, "project.url", 2_048)
  assertNamedRef(input.blocksLinkType, "blocksLinkType")
  assertCanonicalText(
    input.blocksLinkType.outward,
    "blocksLinkType.outward",
    200
  )
  assertCanonicalText(input.blocksLinkType.inward, "blocksLinkType.inward", 200)
  if (
    input.estimateFieldId !== null &&
    !CUSTOM_FIELD_ID.test(input.estimateFieldId)
  ) {
    throw new PlanError("prepared estimateFieldId is invalid")
  }
  if (input.children.length < 1 || input.children.length > MAX_CHILDREN) {
    throw new PlanError(
      `prepared plan must contain one epic and 1-${MAX_CHILDREN} children`
    )
  }
  const children = [...input.children].sort((left, right) =>
    left.clientKey.localeCompare(right.clientKey)
  )
  const nodes = [input.epic, ...children]
  const keys = new Set<string>()
  for (const node of nodes) {
    if (!CLIENT_KEY.test(node.clientKey) || keys.has(node.clientKey)) {
      throw new PlanError("prepared clientKey values are invalid or duplicated")
    }
    keys.add(node.clientKey)
    assertCanonicalText(
      node.summary,
      `${node.clientKey}.summary`,
      MAX_SUMMARY_BYTES
    )
    assertCanonicalText(
      node.description,
      `${node.clientKey}.description`,
      MAX_DESCRIPTION_BYTES,
      true
    )
    assertCanonicalText(
      node.acceptanceCriteria,
      `${node.clientKey}.acceptanceCriteria`,
      MAX_ACCEPTANCE_CRITERIA_BYTES,
      true
    )
    assertNamedRef(node.issueType, `${node.clientKey}.issueType`)
    const labels = [...node.labels].sort()
    if (
      labels.length > MAX_LABELS ||
      JSON.stringify(labels) !== JSON.stringify(node.labels) ||
      new Set(labels).size !== labels.length ||
      labels.some(
        (label) =>
          !LABEL.test(label) || label.toLowerCase().startsWith("notion-page-")
      )
    ) {
      throw new PlanError(`${node.clientKey}.labels are invalid`)
    }
    if (
      node.estimate !== null &&
      (!Number.isSafeInteger(node.estimate) ||
        node.estimate < 0 ||
        node.estimate > 100)
    ) {
      throw new PlanError(`${node.clientKey}.estimate is invalid`)
    }
    if (node.estimate !== null && input.estimateFieldId === null) {
      throw new PlanError(
        `${node.clientKey}.estimate requires a prepared estimateFieldId`
      )
    }
    if (node.assignee) {
      if (
        node.assignee.id.length === 0 ||
        Buffer.byteLength(node.assignee.id, "utf8") > 128 ||
        /[\u0000-\u001f\u007f]/.test(node.assignee.id)
      ) {
        throw new PlanError(`${node.clientKey}.assignee.id is invalid`)
      }
      assertCanonicalText(
        node.assignee.name,
        `${node.clientKey}.assignee.name`,
        200
      )
    }
    if (node.fixVersion)
      assertNamedRef(node.fixVersion, `${node.clientKey}.fixVersion`)
  }
  const childKeys = new Set(children.map((node) => node.clientKey))
  const dependencies = normalizeDependencies(input.dependencies, childKeys)
  if (JSON.stringify(dependencies) !== JSON.stringify(input.dependencies)) {
    throw new PlanError("prepared dependencies must be normalized")
  }
  if (!PLAN_VERSION.test(input.planVersion)) {
    throw new PlanError("prepared planVersion is invalid")
  }
  const { planVersion: _ignored, ...data } = input
  if (buildPlanVersion(data) !== input.planVersion) {
    throw new PlanError("prepared planVersion does not match the exact plan")
  }
  return { ...input, children }
}

export function pageLabel(pageId: string): string {
  return `notion-page-${normalizePageId(pageId)}`
}
