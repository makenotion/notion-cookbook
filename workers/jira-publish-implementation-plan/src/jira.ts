import type { RuntimeConfig } from "./config.js"
import {
  buildPlanVersion,
  MAX_CHILDREN,
  MAX_DEPENDENCIES,
  normalizeDraftPlan,
  normalizePageId,
  pageLabel,
  preparedNodes,
  validatePreparedPlan,
} from "./plan.js"
import type {
  DependencyOutcome,
  DraftNode,
  DraftPlan,
  InspectResult,
  IssueOutcome,
  JiraDependencyView,
  JiraIssueView,
  JiraLinkTypeRef,
  JiraNamedRef,
  JiraPlanMarker,
  JiraProjectRef,
  PageSnapshot,
  PlanDependency,
  PreparedNode,
  PreparedPlan,
  PreparedPlanData,
  PrepareResult,
  PublishResult,
  ResolutionCandidate,
  ResolutionChoice,
} from "./types.js"

type Fetch = typeof globalThis.fetch
type JsonRecord = Record<string, unknown>

const MAX_RESPONSE_BYTES = 1_000_000
const MAX_METADATA_PAGES = 4
const MAX_CANDIDATES = 5
const MAX_CALLS = 160
const MAX_EXECUTION_MS = 55_000
const REQUEST_TIMEOUT_MS = 8_000
const PROPERTY_KEY = "notion.cookbook.jira-plan"
const CLIENT_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/
const PLAN_VERSION = /^sha256:[a-f0-9]{64}$/
const NOTIFICATION_WARNING =
  "Creating Jira work may trigger the project's normal notifications and automation."

type ApiResponse<T> = {
  data: T
  requestId: string | null
}

type IssueTypeMeta = {
  id: string
  name: string
  subtask: boolean
}

type FieldSchema = {
  type: string
  customId: number | null
}

type FieldMeta = {
  fieldId: string
  required: boolean
  hasDefaultValue: boolean
  operations: string[]
  allowedValues: unknown[]
  schema: FieldSchema
}

type UserMeta = {
  accountId: string
  displayName: string
  email: string | null
}

type IssueRef = {
  id: string
  key: string
  url: string
}

type ObservedIssue = {
  ref: IssueRef
  view: JiraIssueView
  marker: JiraPlanMarker
}

type Inspection = InspectResult & {
  observed: Map<string, ObservedIssue>
}

export class JiraError extends Error {
  readonly kind:
    | "auth"
    | "forbidden"
    | "not_found"
    | "conflict"
    | "rate_limited"
    | "unavailable"
    | "ambiguous"
  readonly retryable: boolean
  readonly retryAfterSeconds: number | null
  readonly mutationUnknown: boolean
  readonly requestId: string | null

  constructor(
    message: string,
    options: {
      kind: JiraError["kind"]
      retryable?: boolean
      retryAfterSeconds?: number | null
      mutationUnknown?: boolean
      requestId?: string | null
    }
  ) {
    super(message)
    this.name = "JiraError"
    this.kind = options.kind
    this.retryable = options.retryable ?? false
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
    this.mutationUnknown = options.mutationUnknown ?? false
    this.requestId = options.requestId ?? null
  }
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function numericId(value: unknown): string | null {
  const result = text(value)
  return result && /^[1-9][0-9]{0,31}$/.test(result) ? result : null
}

function bounded(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  const suffix = "…"
  const contentLimit = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"))
  let bytes = 0
  let result = ""
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8")
    if (bytes + characterBytes > contentLimit) break
    result += character
    bytes += characterBytes
  }
  return `${result}${suffix}`
}

function caseFold(value: string): string {
  return value.trim().toLocaleLowerCase("en-US")
}

function dependencyIdentity(value: PlanDependency): string {
  return `${value.blockerClientKey}\u0000${value.blockedClientKey}`
}

function canonicalDependencies(values: PlanDependency[]): PlanDependency[] {
  return [...values].sort(
    (left, right) =>
      left.blockerClientKey.localeCompare(right.blockerClientKey) ||
      left.blockedClientKey.localeCompare(right.blockedClientKey)
  )
}

function markerDependenciesAreValid(
  dependencies: PlanDependency[],
  expectedClientKeys: string[]
): boolean {
  if (dependencies.length > MAX_DEPENDENCIES) return false
  const epicKey = expectedClientKeys[0]
  const allowed = new Set(expectedClientKeys.slice(1))
  const identities = new Set<string>()
  const outgoing = new Map<string, string[]>()
  const indegree = new Map([...allowed].map((key) => [key, 0]))
  for (const dependency of dependencies) {
    if (
      !CLIENT_KEY.test(dependency.blockerClientKey) ||
      !CLIENT_KEY.test(dependency.blockedClientKey) ||
      dependency.blockerClientKey === dependency.blockedClientKey ||
      dependency.blockerClientKey === epicKey ||
      dependency.blockedClientKey === epicKey ||
      !allowed.has(dependency.blockerClientKey) ||
      !allowed.has(dependency.blockedClientKey)
    ) {
      return false
    }
    const identity = dependencyIdentity(dependency)
    if (identities.has(identity)) return false
    identities.add(identity)
    outgoing.set(dependency.blockerClientKey, [
      ...(outgoing.get(dependency.blockerClientKey) ?? []),
      dependency.blockedClientKey,
    ])
    indegree.set(
      dependency.blockedClientKey,
      (indegree.get(dependency.blockedClientKey) ?? 0) + 1
    )
  }
  const queue = [...allowed].filter((key) => indegree.get(key) === 0)
  let visited = 0
  while (queue.length > 0) {
    const current = queue.shift() as string
    visited += 1
    for (const next of outgoing.get(current) ?? []) {
      const value = (indegree.get(next) ?? 0) - 1
      indegree.set(next, value)
      if (value === 0) queue.push(next)
    }
  }
  return visited === allowed.size
}

function requestId(response: Response): string | null {
  return (
    response.headers.get("x-arequestid") ??
    response.headers.get("x-request-id") ??
    response.headers.get("atl-traceid")
  )
}

function boundedRetryAfterSeconds(value: number): number {
  return Math.max(0, Math.min(86_400, Math.ceil(value)))
}

function retryAfter(response: Response): number | null {
  const value = response.headers.get("retry-after")
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return boundedRetryAfterSeconds(seconds)
  const date = Date.parse(value)
  return Number.isNaN(date)
    ? null
    : boundedRetryAfterSeconds((date - Date.now()) / 1_000)
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

async function readBoundedBody(
  response: Response,
  mutation: boolean
): Promise<string> {
  const declared = response.headers.get("content-length")
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
    await discardBody(response)
    throw new JiraError("Jira response exceeded the fixed body limit", {
      kind: mutation ? "ambiguous" : "unavailable",
      retryable: true,
      mutationUnknown: mutation,
      requestId: requestId(response),
    })
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new JiraError("Jira response exceeded the fixed body limit", {
        kind: mutation ? "ambiguous" : "unavailable",
        retryable: true,
        mutationUnknown: mutation,
        requestId: requestId(response),
      })
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

function httpError(response: Response, mutationPath: string | null): JiraError {
  const status = response.status
  const providerRequestId = requestId(response)
  const delay = retryAfter(response)
  if (mutationPath !== null) {
    const definite: Record<string, Set<number>> = {
      "/rest/api/3/issue": new Set([400, 401, 403, 422]),
      "/rest/api/3/issueLink": new Set([400, 401, 403, 404, 413]),
    }
    if (!definite[mutationPath]?.has(status)) {
      return new JiraError(
        `Jira mutation outcome is unknown (HTTP ${status})`,
        {
          kind: "ambiguous",
          retryable: true,
          retryAfterSeconds: delay,
          mutationUnknown: true,
          requestId: providerRequestId,
        }
      )
    }
  }
  if (status === 401) {
    return new JiraError("Jira authentication failed (HTTP 401)", {
      kind: "auth",
      requestId: providerRequestId,
    })
  }
  if (status === 403) {
    return new JiraError("Jira denied the operation (HTTP 403)", {
      kind: "forbidden",
      requestId: providerRequestId,
    })
  }
  if (status === 404) {
    return new JiraError("Jira resource was not found (HTTP 404)", {
      kind: "not_found",
      requestId: providerRequestId,
    })
  }
  if (status === 429) {
    return new JiraError("Jira rate limited the request (HTTP 429)", {
      kind: "rate_limited",
      retryable: true,
      retryAfterSeconds: delay,
      requestId: providerRequestId,
    })
  }
  if ([400, 409, 412, 422].includes(status)) {
    return new JiraError(`Jira rejected current state (HTTP ${status})`, {
      kind: "conflict",
      requestId: providerRequestId,
    })
  }
  return new JiraError(`Jira request failed (HTTP ${status})`, {
    kind: "unavailable",
    retryable: status === 408 || status >= 500,
    retryAfterSeconds: delay,
    requestId: providerRequestId,
  })
}

function choice(
  field: string,
  query: string,
  candidates: ResolutionCandidate[],
  hasMore = false
): ResolutionChoice {
  return {
    field,
    query,
    candidates: candidates.slice(0, MAX_CANDIDATES),
    hasMore: hasMore || candidates.length > MAX_CANDIDATES,
  }
}

function rankedCandidates<T extends { id: string; name: string }>(
  query: string,
  values: T[],
  detail: (value: T) => string
): ResolutionCandidate[] {
  const folded = caseFold(query)
  return [...values]
    .sort((left, right) => {
      const leftName = caseFold(left.name)
      const rightName = caseFold(right.name)
      const leftRank =
        leftName === folded ? 0 : leftName.includes(folded) ? 1 : 2
      const rightRank =
        rightName === folded ? 0 : rightName.includes(folded) ? 1 : 2
      return leftRank - rightRank || left.name.localeCompare(right.name)
    })
    .map((value) => ({
      id: value.id,
      label: bounded(value.name, 200),
      detail: bounded(detail(value), 300),
    }))
}

function exactNamedMatch<T extends { id: string; name: string }>(
  query: string,
  values: T[]
): T | null {
  const matches = values.filter(
    (value) => caseFold(value.name) === caseFold(query)
  )
  return matches.length === 1 ? matches[0] : null
}

export class JiraClient {
  static readonly PROPERTY_KEY = PROPERTY_KEY

  private readonly fetch: Fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly startedAt: number
  private calls = 0

  constructor(
    private readonly config: RuntimeConfig,
    options: {
      fetch?: Fetch
      sleep?: (ms: number) => Promise<void>
      now?: () => number
    } = {}
  ) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.now = options.now ?? Date.now
    this.startedAt = this.now()
  }

  async prepare(
    input: DraftPlan,
    source: PageSnapshot
  ): Promise<PrepareResult> {
    const plan = normalizeDraftPlan(input)
    if (plan.sourcePageId !== source.pageId) {
      throw new JiraError(
        "The prepared plan references a different Notion page",
        {
          kind: "conflict",
        }
      )
    }
    const project = await this.verifyProject()
    const issueTypes = [...(await this.fetchIssueTypes()).values()].filter(
      (item) => !item.subtask
    )
    const choices: ResolutionChoice[] = []
    const drafts = [plan.epic, ...plan.children]
    const typeByClientKey = new Map<string, IssueTypeMeta>()

    for (const [index, node] of drafts.entries()) {
      const match = node.issueTypeId
        ? (issueTypes.find((value) => value.id === node.issueTypeId) ?? null)
        : exactNamedMatch(node.issueTypeName, issueTypes)
      const field =
        index === 0 ? "epic.issueTypeId" : `children[${index - 1}].issueTypeId`
      if (!match) {
        choices.push(
          choice(
            field,
            node.issueTypeName,
            rankedCandidates(
              node.issueTypeName,
              issueTypes,
              () => "Creatable Jira issue type"
            )
          )
        )
      } else {
        typeByClientKey.set(node.clientKey, match)
      }
    }

    const assigneeByClientKey = new Map<string, JiraNamedRef | null>()
    for (const [index, node] of drafts.entries()) {
      if (node.assigneeName === null) {
        assigneeByClientKey.set(node.clientKey, null)
        continue
      }
      const field =
        index === 0
          ? "epic.assigneeAccountId"
          : `children[${index - 1}].assigneeAccountId`
      const resolved = await this.resolveAssignee(
        node.assigneeName,
        node.assigneeAccountId
      )
      if (resolved.match) {
        assigneeByClientKey.set(node.clientKey, resolved.match)
      } else {
        choices.push(
          choice(
            field,
            node.assigneeName,
            resolved.candidates,
            resolved.hasMore
          )
        )
      }
    }

    if (choices.length > 0) {
      return {
        ok: false,
        status: "needs_choice",
        preparedPlan: null,
        choices,
        observedIssues: [],
        warnings: [],
        message:
          "Some Jira names were missing or ambiguous. Ask the user to choose from the returned current Jira values.",
        nextAction: "ask_user",
      }
    }

    const uniqueTypes = new Map(
      [...typeByClientKey.values()].map((value) => [value.id, value])
    )
    const hierarchyByType = new Map<string, number>()
    const fieldsByType = new Map<string, Map<string, FieldMeta>>()
    for (const issueType of uniqueTypes.values()) {
      hierarchyByType.set(
        issueType.id,
        await this.fetchHierarchyLevel(issueType.id)
      )
      fieldsByType.set(issueType.id, await this.fetchFields(issueType.id))
    }

    const epicType = typeByClientKey.get(plan.epic.clientKey) as IssueTypeMeta
    if (hierarchyByType.get(epicType.id) !== 1) {
      throw new JiraError(
        "The selected Jira issue type is not currently an epic-level type",
        { kind: "conflict" }
      )
    }
    for (const child of plan.children) {
      const issueType = typeByClientKey.get(child.clientKey) as IssueTypeMeta
      if (hierarchyByType.get(issueType.id) !== 0) {
        throw new JiraError(
          `${child.clientKey}: the selected Jira issue type is not currently a standard child type`,
          { kind: "conflict" }
        )
      }
    }

    const fixVersionByClientKey = new Map<string, JiraNamedRef | null>()
    for (const [index, node] of drafts.entries()) {
      const issueType = typeByClientKey.get(node.clientKey) as IssueTypeMeta
      const fields = fieldsByType.get(issueType.id) as Map<string, FieldMeta>
      this.validateCreateFields(fields, node, index > 0)
      if (node.fixVersionName === null) {
        fixVersionByClientKey.set(node.clientKey, null)
        continue
      }
      const versions = this.allowedNamedValues(fields.get("fixVersions"))
      const match = node.fixVersionId
        ? (versions.find((value) => value.id === node.fixVersionId) ?? null)
        : exactNamedMatch(node.fixVersionName, versions)
      const field =
        index === 0
          ? "epic.fixVersionId"
          : `children[${index - 1}].fixVersionId`
      if (!match) {
        choices.push(
          choice(
            field,
            node.fixVersionName,
            rankedCandidates(
              node.fixVersionName,
              versions,
              () => "Selectable Jira fix version"
            )
          )
        )
      } else {
        fixVersionByClientKey.set(node.clientKey, match)
      }
    }

    if (choices.length > 0) {
      return {
        ok: false,
        status: "needs_choice",
        preparedPlan: null,
        choices,
        observedIssues: [],
        warnings: [],
        message:
          "Some Jira planning values were missing or ambiguous. Ask the user to choose from the returned current values.",
        nextAction: "ask_user",
      }
    }

    const blocksLinkType = await this.fetchBlocksLinkType()
    const nodes: PreparedNode[] = drafts.map((node) => {
      const issueType = typeByClientKey.get(node.clientKey) as IssueTypeMeta
      return {
        clientKey: node.clientKey,
        summary: node.summary,
        description: node.description,
        acceptanceCriteria: node.acceptanceCriteria,
        issueType: { id: issueType.id, name: issueType.name },
        assignee: assigneeByClientKey.get(node.clientKey) ?? null,
        labels: node.labels,
        estimate: node.estimate,
        fixVersion: fixVersionByClientKey.get(node.clientKey) ?? null,
      }
    })
    const data: PreparedPlanData = {
      source,
      project,
      blocksLinkType,
      estimateFieldId: this.config.estimateFieldId,
      epic: nodes[0],
      children: nodes.slice(1),
      dependencies: plan.dependencies,
    }
    const preparedPlan = validatePreparedPlan({
      ...data,
      planVersion: buildPlanVersion(data),
    })
    const inspection = await this.inspectInternal(source.pageId, project)
    if (inspection.status === "not_observed") {
      return {
        ok: true,
        status: "ready",
        preparedPlan,
        choices: [],
        observedIssues: [],
        warnings: [NOTIFICATION_WARNING],
        message:
          "The plan is valid against current Jira metadata. Show the exact preview and ask for confirmation before publishing.",
        nextAction: "confirm_publish",
      }
    }
    if (
      inspection.source !== null &&
      inspection.source.lastEditedTime !== source.lastEditedTime
    ) {
      return {
        ok: false,
        status: "conflict",
        preparedPlan: null,
        choices: [],
        observedIssues: inspection.issues,
        warnings: inspection.warnings,
        message:
          "This page has Jira work prepared from a different Notion page edit time. This recipe does not republish changed plans.",
        nextAction: "manual_review",
      }
    }
    if (
      inspection.planVersion === preparedPlan.planVersion &&
      ["complete", "partial"].includes(inspection.status)
    ) {
      try {
        await this.verifyObservedNodes(preparedPlan, inspection)
      } catch (error) {
        if (!(error instanceof JiraError)) throw error
        return {
          ok: false,
          status: "conflict",
          preparedPlan: null,
          choices: [],
          observedIssues: inspection.issues,
          warnings: inspection.warnings,
          message:
            "Marked Jira work no longer matches the prepared fields. This recipe does not overwrite drifted work.",
          nextAction: "manual_review",
        }
      }
    }
    if (
      inspection.status === "complete" &&
      inspection.planVersion === preparedPlan.planVersion
    ) {
      return {
        ok: true,
        status: "already_published",
        preparedPlan,
        choices: [],
        observedIssues: inspection.issues,
        warnings: inspection.warnings,
        message:
          "Jira already contains the complete exact plan; publishing would be a no-op.",
        nextAction: "no_action",
      }
    }
    if (
      inspection.status === "partial" &&
      inspection.planVersion === preparedPlan.planVersion
    ) {
      return {
        ok: false,
        status: "partial",
        preparedPlan,
        choices: [],
        observedIssues: inspection.issues,
        warnings: inspection.warnings,
        message:
          "Jira contains part of this exact plan. Inspect the existing work before deciding whether to resume.",
        nextAction: "inspect_again",
      }
    }
    return {
      ok: false,
      status: "conflict",
      preparedPlan: null,
      choices: [],
      observedIssues: inspection.issues,
      warnings: inspection.warnings,
      message:
        "This Notion page has Jira work for a different or conflicting publication. This recipe does not update an existing plan.",
      nextAction: "manual_review",
    }
  }

  async inspect(sourcePageId: string): Promise<InspectResult> {
    const project = await this.verifyProject()
    const { observed: _observed, ...result } = await this.inspectInternal(
      normalizePageId(sourcePageId),
      project
    )
    return result
  }

  async publish(
    input: PreparedPlan,
    currentSource: PageSnapshot
  ): Promise<PublishResult> {
    const plan = validatePreparedPlan(input)
    const nodes = preparedNodes(plan)
    const issueOutcomes = new Map<string, IssueOutcome>(
      nodes.map((node) => [
        node.clientKey,
        {
          clientKey: node.clientKey,
          state: "not_attempted",
          id: null,
          key: null,
          url: null,
        },
      ])
    )
    const dependencyOutcomes = new Map<string, DependencyOutcome>(
      plan.dependencies.map((dependency) => [
        dependencyIdentity(dependency),
        { ...dependency, state: "not_attempted" },
      ])
    )
    const result = (
      values: Partial<PublishResult> &
        Pick<PublishResult, "status" | "changed" | "message" | "nextAction">
    ): PublishResult => ({
      ok: ["completed", "no_op"].includes(values.status),
      status: values.status,
      changed: values.changed,
      source: plan.source,
      project: plan.project,
      planVersion: plan.planVersion,
      issues: nodes.map(
        (node) => issueOutcomes.get(node.clientKey) as IssueOutcome
      ),
      dependencies: plan.dependencies.map(
        (dependency) =>
          dependencyOutcomes.get(
            dependencyIdentity(dependency)
          ) as DependencyOutcome
      ),
      warnings: values.warnings ?? [NOTIFICATION_WARNING],
      message: values.message,
      nextAction: values.nextAction,
      retryAfterSeconds: values.retryAfterSeconds ?? null,
      requestId: values.requestId ?? null,
    })

    if (
      currentSource.pageId !== plan.source.pageId ||
      currentSource.url !== plan.source.url ||
      currentSource.lastEditedTime !== plan.source.lastEditedTime
    ) {
      return result({
        status: "conflict",
        changed: false,
        message:
          "The Notion page edit time changed after preparation. Prepare a new preview before publishing.",
        nextAction: "prepare_again",
      })
    }
    if (
      plan.project.id !== this.config.projectId ||
      plan.project.key !== this.config.projectKey ||
      plan.project.url !==
        `${this.config.siteUrl}/browse/${encodeURIComponent(this.config.projectKey)}` ||
      plan.blocksLinkType.id !== this.config.blocksLinkTypeId ||
      plan.estimateFieldId !== this.config.estimateFieldId
    ) {
      return result({
        status: "conflict",
        changed: false,
        message:
          "The prepared destination no longer matches this Worker configuration.",
        nextAction: "prepare_again",
      })
    }

    const project = await this.verifyProject()
    if (
      project.id !== plan.project.id ||
      project.key !== plan.project.key ||
      project.url !== plan.project.url
    ) {
      return result({
        status: "conflict",
        changed: false,
        message: "The configured Jira project changed after preparation.",
        nextAction: "prepare_again",
      })
    }
    await this.revalidatePreparedPlan(plan)
    const inspection = await this.inspectInternal(plan.source.pageId, project)
    if (
      inspection.status === "conflict" ||
      (inspection.planVersion !== null &&
        inspection.planVersion !== plan.planVersion) ||
      (inspection.source !== null &&
        inspection.source.lastEditedTime !== plan.source.lastEditedTime)
    ) {
      return result({
        status: "conflict",
        changed: false,
        message:
          "Jira contains marked work for a different or conflicting plan. No writes were sent.",
        nextAction: "manual_review",
      })
    }

    const refs = await this.verifyObservedNodes(plan, inspection)
    for (const node of nodes) {
      const existing = refs.get(node.clientKey)
      if (!existing) continue
      issueOutcomes.set(node.clientKey, {
        clientKey: node.clientKey,
        state: "existing",
        id: existing.id,
        key: existing.key,
        url: existing.url,
      })
    }

    let knownChange = false
    let lastRequestId: string | null = null
    for (const node of nodes) {
      if (refs.has(node.clientKey)) continue
      const parent =
        node === plan.epic ? null : (refs.get(plan.epic.clientKey) ?? null)
      if (node !== plan.epic && parent === null) {
        issueOutcomes.set(node.clientKey, {
          clientKey: node.clientKey,
          state: "rejected",
          id: null,
          key: null,
          url: null,
        })
        return result({
          status: refs.size > 0 ? "partial" : "blocked",
          changed: knownChange,
          message:
            "A child could not be created because its epic was unavailable.",
          nextAction: "inspect_again",
          requestId: lastRequestId,
        })
      }
      try {
        const created = await this.createNode(plan, node, parent)
        knownChange = true
        lastRequestId = created.requestId
        refs.set(node.clientKey, created.ref)
        issueOutcomes.set(node.clientKey, {
          clientKey: node.clientKey,
          state: "created",
          id: created.ref.id,
          key: created.ref.key,
          url: created.ref.url,
        })
      } catch (error) {
        if (!(error instanceof JiraError)) throw error
        issueOutcomes.set(node.clientKey, {
          clientKey: node.clientKey,
          state: error.mutationUnknown ? "unknown" : "rejected",
          id: null,
          key: null,
          url: null,
        })
        return result({
          status: error.mutationUnknown
            ? "ambiguous"
            : refs.size > 0
              ? "partial"
              : error.kind === "conflict"
                ? "conflict"
                : "blocked",
          changed: error.mutationUnknown ? null : knownChange,
          message: error.mutationUnknown
            ? "A Jira create outcome is unknown. No later writes were attempted; inspect Jira before taking another action."
            : `Jira rejected a work item. No later writes were attempted. ${error.message}`,
          nextAction: error.mutationUnknown ? "inspect_again" : "manual_review",
          retryAfterSeconds: error.retryAfterSeconds,
          requestId: error.requestId ?? lastRequestId,
        })
      }
    }

    for (const dependency of plan.dependencies) {
      const blocker = refs.get(dependency.blockerClientKey) as IssueRef
      const blocked = refs.get(dependency.blockedClientKey) as IssueRef
      const identity = dependencyIdentity(dependency)
      let exists: boolean
      try {
        exists = await this.dependencyExists(blocker, blocked)
      } catch (error) {
        if (!(error instanceof JiraError)) throw error
        return result({
          status: refs.size > 0 ? "partial" : "blocked",
          changed: knownChange,
          message:
            "Jira work items are resolved, but the Worker could not inspect their dependency links. No link write was attempted.",
          nextAction: "inspect_again",
          retryAfterSeconds: error.retryAfterSeconds,
          requestId: error.requestId ?? lastRequestId,
        })
      }
      if (exists) {
        dependencyOutcomes.set(identity, { ...dependency, state: "existing" })
        continue
      }
      try {
        const created = await this.createDependency(blocker, blocked)
        knownChange = true
        lastRequestId = created.requestId
        dependencyOutcomes.set(identity, { ...dependency, state: "created" })
      } catch (error) {
        if (!(error instanceof JiraError)) throw error
        dependencyOutcomes.set(identity, {
          ...dependency,
          state: error.mutationUnknown ? "unknown" : "rejected",
        })
        return result({
          status: error.mutationUnknown ? "ambiguous" : "partial",
          changed: error.mutationUnknown ? null : knownChange,
          message: error.mutationUnknown
            ? "A Jira dependency outcome is unknown. No later writes were attempted; inspect Jira before taking another action."
            : `Jira rejected a dependency. No later writes were attempted. ${error.message}`,
          nextAction: error.mutationUnknown ? "inspect_again" : "manual_review",
          retryAfterSeconds: error.retryAfterSeconds,
          requestId: error.requestId ?? lastRequestId,
        })
      }
    }

    return result({
      status: knownChange ? "completed" : "no_op",
      changed: knownChange,
      message: knownChange
        ? "Jira contains the complete confirmed implementation plan."
        : "Jira already contained the complete exact plan; no writes were sent.",
      nextAction: "none",
      requestId: lastRequestId,
    })
  }

  private async resolveAssignee(
    queryText: string,
    selectedAccountId: string | null
  ): Promise<{
    match: JiraNamedRef | null
    candidates: ResolutionCandidate[]
    hasMore: boolean
  }> {
    const query = new URLSearchParams(
      selectedAccountId
        ? {
            project: this.config.projectKey,
            accountId: selectedAccountId,
            startAt: "0",
            maxResults: "2",
          }
        : {
            project: this.config.projectKey,
            query: queryText,
            startAt: "0",
            maxResults: String(MAX_CANDIDATES + 1),
          }
    )
    const response = await this.readJson(
      `/rest/api/3/user/assignable/search?${query.toString()}`
    )
    if (!Array.isArray(response)) {
      throw new JiraError("Jira assignable-user response was malformed", {
        kind: "unavailable",
        retryable: true,
      })
    }
    const users: UserMeta[] = response
      .map((value) => {
        const item = record(value)
        const accountId = text(item?.accountId)
        const displayName = text(item?.displayName)
        const email = text(item?.emailAddress)
        if (!accountId || !displayName || item?.active !== true) return null
        return { accountId, displayName, email }
      })
      .filter((value): value is UserMeta => value !== null)
    if (selectedAccountId) {
      const selected = users.find(
        (user) => user.accountId === selectedAccountId
      )
      return {
        match: selected
          ? { id: selected.accountId, name: selected.displayName }
          : null,
        candidates: users.map((user) => ({
          id: user.accountId,
          label: bounded(user.displayName, 200),
          detail: bounded(user.email ?? "Assignable Jira user", 300),
        })),
        hasMore: false,
      }
    }
    return {
      // Jira filters assignability after paging through its user directory, so
      // even a short response does not prove that a same-named user is unique.
      // Require the user to choose a concrete account before resolving it.
      match: null,
      candidates: users.map((user) => ({
        id: user.accountId,
        label: bounded(user.displayName, 200),
        detail: bounded(user.email ?? "Assignable Jira user", 300),
      })),
      hasMore: true,
    }
  }

  private async verifyProject(): Promise<JiraProjectRef> {
    const server = record(await this.readJson("/rest/api/3/serverInfo"))
    const baseUrl = text(server?.baseUrl)?.replace(/\/$/, "")
    if (baseUrl !== this.config.siteUrl) {
      throw new JiraError(
        "Configured Jira site URL does not match the authenticated Jira site",
        { kind: "conflict" }
      )
    }
    const project = record(
      await this.readJson(
        `/rest/api/3/project/${encodeURIComponent(this.config.projectId)}`
      )
    )
    const id = numericId(project?.id)
    const key = text(project?.key)
    const name = text(project?.name)
    if (
      id !== this.config.projectId ||
      key !== this.config.projectKey ||
      !name
    ) {
      throw new JiraError(
        "Configured Jira project ID and key no longer match",
        {
          kind: "conflict",
        }
      )
    }
    return {
      id,
      key,
      name: bounded(name, 200),
      url: `${this.config.siteUrl}/browse/${encodeURIComponent(key)}`,
    }
  }

  private async fetchIssueTypes(): Promise<Map<string, IssueTypeMeta>> {
    const result = new Map<string, IssueTypeMeta>()
    let startAt = 0
    for (let page = 0; page < MAX_METADATA_PAGES; page += 1) {
      const query = new URLSearchParams({
        startAt: String(startAt),
        maxResults: "50",
      })
      const body = record(
        await this.readJson(
          `/rest/api/3/issue/createmeta/${this.config.projectId}/issuetypes?${query.toString()}`
        )
      )
      const values = body?.issueTypes
      if (!Array.isArray(values)) {
        throw new JiraError("Jira issue-type metadata was malformed", {
          kind: "unavailable",
          retryable: true,
        })
      }
      for (const value of values) {
        const item = record(value)
        const id = numericId(item?.id)
        const name = text(item?.name)
        if (
          !id ||
          !name ||
          typeof item?.subtask !== "boolean" ||
          result.has(id)
        ) {
          throw new JiraError("Jira issue-type metadata had invalid fields", {
            kind: "unavailable",
            retryable: true,
          })
        }
        result.set(id, { id, name: bounded(name, 200), subtask: item.subtask })
      }
      const total = Number(body?.total)
      const observedStart = Number(body?.startAt)
      if (!Number.isSafeInteger(total) || observedStart !== startAt) {
        throw new JiraError("Jira issue-type pagination was malformed", {
          kind: "unavailable",
          retryable: true,
        })
      }
      startAt += values.length
      if (startAt >= total) return result
      if (values.length === 0) break
    }
    throw new JiraError("Jira issue-type metadata exceeded the page limit", {
      kind: "conflict",
    })
  }

  private async fetchHierarchyLevel(issueTypeId: string): Promise<number> {
    const body = record(
      await this.readJson(
        `/rest/api/3/issuetype/${encodeURIComponent(issueTypeId)}`
      )
    )
    const level = body?.hierarchyLevel
    if (typeof level !== "number" || !Number.isSafeInteger(level)) {
      throw new JiraError("Jira issue-type hierarchy metadata was malformed", {
        kind: "unavailable",
        retryable: true,
      })
    }
    return level
  }

  private async fetchFields(
    issueTypeId: string
  ): Promise<Map<string, FieldMeta>> {
    const result = new Map<string, FieldMeta>()
    let startAt = 0
    for (let page = 0; page < MAX_METADATA_PAGES; page += 1) {
      const query = new URLSearchParams({
        startAt: String(startAt),
        maxResults: "50",
      })
      const body = record(
        await this.readJson(
          `/rest/api/3/issue/createmeta/${this.config.projectId}/issuetypes/${encodeURIComponent(issueTypeId)}?${query.toString()}`
        )
      )
      const values = body?.fields
      if (!Array.isArray(values)) {
        throw new JiraError("Jira create-field metadata was malformed", {
          kind: "unavailable",
          retryable: true,
        })
      }
      for (const value of values) {
        const item = record(value)
        const fieldId = text(item?.fieldId)
        const operations = item?.operations
        const allowedValues = item?.allowedValues ?? []
        const schema = record(item?.schema)
        const schemaType = text(schema?.type)
        if (
          !fieldId ||
          typeof item?.required !== "boolean" ||
          typeof item?.hasDefaultValue !== "boolean" ||
          !Array.isArray(operations) ||
          operations.some((operation) => typeof operation !== "string") ||
          !Array.isArray(allowedValues) ||
          !schemaType
        ) {
          throw new JiraError("Jira create-field metadata had invalid fields", {
            kind: "unavailable",
            retryable: true,
          })
        }
        result.set(fieldId, {
          fieldId,
          required: item.required,
          hasDefaultValue: item.hasDefaultValue,
          operations: operations as string[],
          allowedValues,
          schema: {
            type: schemaType,
            customId:
              typeof schema?.customId === "number" &&
              Number.isSafeInteger(schema.customId)
                ? schema.customId
                : null,
          },
        })
      }
      const total = Number(body?.total)
      const observedStart = Number(body?.startAt)
      if (!Number.isSafeInteger(total) || observedStart !== startAt) {
        throw new JiraError("Jira create-field pagination was malformed", {
          kind: "unavailable",
          retryable: true,
        })
      }
      startAt += values.length
      if (startAt >= total) return result
      if (values.length === 0) break
    }
    throw new JiraError("Jira create-field metadata exceeded the page limit", {
      kind: "conflict",
    })
  }

  private validateCreateFields(
    fields: Map<string, FieldMeta>,
    node: DraftNode | PreparedNode,
    child: boolean
  ): void {
    const requiredByWorker = new Set([
      "project",
      "issuetype",
      "summary",
      "description",
      "labels",
    ])
    if (child) requiredByWorker.add("parent")
    const assignee = "assigneeName" in node ? node.assigneeName : node.assignee
    const fixVersion =
      "fixVersionName" in node ? node.fixVersionName : node.fixVersion
    if (assignee !== null) requiredByWorker.add("assignee")
    if (fixVersion !== null) requiredByWorker.add("fixVersions")
    if (node.estimate !== null) {
      if (!this.config.estimateFieldId) {
        throw new JiraError(
          "This plan includes estimates but JIRA_ESTIMATE_FIELD_ID is not configured",
          { kind: "conflict" }
        )
      }
      requiredByWorker.add(this.config.estimateFieldId)
    }
    for (const fieldId of requiredByWorker) {
      const field = fields.get(fieldId)
      if (!field || !field.operations.includes("set")) {
        throw new JiraError(
          `Current Jira create metadata does not allow field ${fieldId}`,
          { kind: "conflict" }
        )
      }
    }
    for (const field of fields.values()) {
      if (
        field.required &&
        !field.hasDefaultValue &&
        !requiredByWorker.has(field.fieldId)
      ) {
        throw new JiraError(
          `Required Jira field ${field.fieldId} is not supported by this recipe`,
          { kind: "conflict" }
        )
      }
    }
    if (node.estimate !== null && this.config.estimateFieldId) {
      const field = fields.get(this.config.estimateFieldId)
      const expectedCustomId = Number(this.config.estimateFieldId.slice(12))
      if (
        !field ||
        field.schema.type !== "number" ||
        field.schema.customId !== expectedCustomId
      ) {
        throw new JiraError(
          "Configured estimate field does not have Jira numeric-field semantics",
          { kind: "conflict" }
        )
      }
    }
  }

  private allowedNamedValues(field: FieldMeta | undefined): JiraNamedRef[] {
    if (!field) return []
    return field.allowedValues
      .map((value) => {
        const item = record(value)
        const rawId = item?.id
        const id =
          typeof rawId === "number" && Number.isSafeInteger(rawId)
            ? String(rawId)
            : numericId(rawId)
        const name = text(item?.name)
        return id && name ? { id, name: bounded(name, 200) } : null
      })
      .filter((value): value is JiraNamedRef => value !== null)
  }

  private async fetchBlocksLinkType(): Promise<JiraLinkTypeRef> {
    const body = record(await this.readJson("/rest/api/3/issueLinkType"))
    const values = body?.issueLinkTypes
    if (!Array.isArray(values)) {
      throw new JiraError("Jira issue-link metadata was malformed", {
        kind: "unavailable",
        retryable: true,
      })
    }
    const item = record(
      values.find(
        (value) => text(record(value)?.id) === this.config.blocksLinkTypeId
      )
    )
    const id = numericId(item?.id)
    const name = text(item?.name)
    const outward = text(item?.outward)
    const inward = text(item?.inward)
    if (!id || !name || !outward || !inward) {
      throw new JiraError("Configured Jira blocks link type is unavailable", {
        kind: "conflict",
      })
    }
    return {
      id,
      name: bounded(name, 200),
      outward: bounded(outward, 200),
      inward: bounded(inward, 200),
    }
  }

  private async verifyObservedNodes(
    plan: PreparedPlan,
    inspection: Inspection
  ): Promise<Map<string, IssueRef>> {
    const refs = new Map<string, IssueRef>()
    for (const node of preparedNodes(plan)) {
      const existing = inspection.observed.get(node.clientKey)
      if (!existing) continue
      const parent =
        node === plan.epic ? null : (refs.get(plan.epic.clientKey) ?? null)
      if (node !== plan.epic && parent === null) {
        throw new JiraError(
          `${node.clientKey}: marked child exists without its expected marked epic`,
          { kind: "conflict" }
        )
      }
      await this.verifyExactNode(existing.ref, plan, node, parent)
      refs.set(node.clientKey, existing.ref)
    }
    return refs
  }

  private async revalidatePreparedPlan(plan: PreparedPlan): Promise<void> {
    const issueTypes = await this.fetchIssueTypes()
    const fieldsByType = new Map<string, Map<string, FieldMeta>>()
    for (const [index, node] of preparedNodes(plan).entries()) {
      const currentType = issueTypes.get(node.issueType.id)
      if (!currentType) {
        throw new JiraError(`${node.clientKey}: Jira issue type changed`, {
          kind: "conflict",
        })
      }
      const expectedLevel = index === 0 ? 1 : 0
      if (
        (await this.fetchHierarchyLevel(node.issueType.id)) !== expectedLevel
      ) {
        throw new JiraError(`${node.clientKey}: Jira hierarchy changed`, {
          kind: "conflict",
        })
      }
      let fields = fieldsByType.get(node.issueType.id)
      if (!fields) {
        fields = await this.fetchFields(node.issueType.id)
        fieldsByType.set(node.issueType.id, fields)
      }
      this.validateCreateFields(fields, node, index > 0)
      if (node.fixVersion) {
        const current = this.allowedNamedValues(fields.get("fixVersions"))
        if (!current.some((version) => version.id === node.fixVersion?.id)) {
          throw new JiraError(`${node.clientKey}: Jira fix version changed`, {
            kind: "conflict",
          })
        }
      }
      if (node.assignee) await this.verifyAssignable(node.assignee)
    }
    const linkType = await this.fetchBlocksLinkType()
    if (
      linkType.id !== plan.blocksLinkType.id ||
      linkType.name !== plan.blocksLinkType.name ||
      linkType.outward !== plan.blocksLinkType.outward ||
      linkType.inward !== plan.blocksLinkType.inward
    ) {
      throw new JiraError(
        "Jira blocks link semantics changed after preparation",
        {
          kind: "conflict",
        }
      )
    }
  }

  private async verifyAssignable(assignee: JiraNamedRef): Promise<void> {
    const query = new URLSearchParams({
      project: this.config.projectKey,
      accountId: assignee.id,
      startAt: "0",
      maxResults: "2",
    })
    const response = await this.readJson(
      `/rest/api/3/user/assignable/search?${query.toString()}`
    )
    if (
      !Array.isArray(response) ||
      response.length !== 1 ||
      text(record(response[0])?.accountId) !== assignee.id ||
      record(response[0])?.active !== true
    ) {
      throw new JiraError(
        "The selected Jira assignee is no longer uniquely assignable to this project",
        { kind: "conflict" }
      )
    }
  }

  private marker(plan: PreparedPlan, node: PreparedNode): JiraPlanMarker {
    return {
      version: 1,
      sourcePageId: normalizePageId(plan.source.pageId),
      sourceLastEditedTime: plan.source.lastEditedTime,
      planVersion: plan.planVersion,
      clientKey: node.clientKey,
      expectedClientKeys: preparedNodes(plan).map((item) => item.clientKey),
      dependencies: canonicalDependencies(plan.dependencies),
    }
  }

  private parseMarker(value: unknown): JiraPlanMarker | null {
    const item = record(value)
    if (
      item?.version !== 1 ||
      typeof item.sourcePageId !== "string" ||
      typeof item.sourceLastEditedTime !== "string" ||
      typeof item.planVersion !== "string" ||
      typeof item.clientKey !== "string" ||
      !Array.isArray(item.expectedClientKeys) ||
      !Array.isArray(item.dependencies)
    ) {
      return null
    }
    const expectedClientKeys = item.expectedClientKeys
    let normalizedSourcePageId: string
    try {
      normalizedSourcePageId = normalizePageId(item.sourcePageId)
    } catch {
      return null
    }
    if (
      normalizedSourcePageId !== item.sourcePageId ||
      item.sourceLastEditedTime.length > 100 ||
      Number.isNaN(Date.parse(item.sourceLastEditedTime)) ||
      !PLAN_VERSION.test(item.planVersion) ||
      !CLIENT_KEY.test(item.clientKey) ||
      expectedClientKeys.length < 2 ||
      expectedClientKeys.length > MAX_CHILDREN + 1 ||
      expectedClientKeys.some(
        (key) => typeof key !== "string" || !CLIENT_KEY.test(key)
      ) ||
      new Set(expectedClientKeys).size !== expectedClientKeys.length ||
      !expectedClientKeys.includes(item.clientKey) ||
      item.dependencies.length > MAX_DEPENDENCIES
    ) {
      return null
    }
    const dependencies: PlanDependency[] = []
    for (const value of item.dependencies) {
      const dependency = record(value)
      if (
        typeof dependency?.blockerClientKey !== "string" ||
        typeof dependency?.blockedClientKey !== "string"
      ) {
        return null
      }
      dependencies.push({
        blockerClientKey: dependency.blockerClientKey,
        blockedClientKey: dependency.blockedClientKey,
      })
    }
    if (
      !markerDependenciesAreValid(dependencies, expectedClientKeys as string[])
    ) {
      return null
    }
    return {
      version: 1,
      sourcePageId: item.sourcePageId,
      sourceLastEditedTime: item.sourceLastEditedTime,
      planVersion: item.planVersion,
      clientKey: item.clientKey,
      expectedClientKeys: [...expectedClientKeys] as string[],
      dependencies: canonicalDependencies(dependencies),
    }
  }

  private async inspectInternal(
    sourcePageId: string,
    project: JiraProjectRef
  ): Promise<Inspection> {
    const markerLabel = pageLabel(sourcePageId)
    const search = record(
      await this.readJson("/rest/api/3/search/jql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jql: `project = "${this.config.projectKey}" AND labels = "${markerLabel}" ORDER BY id ASC`,
          maxResults: MAX_CHILDREN + 2,
          fields: ["id", "key"],
        }),
      })
    )
    const matches = search?.issues
    if (!Array.isArray(matches)) {
      throw new JiraError("Jira marker search response was malformed", {
        kind: "unavailable",
        retryable: true,
      })
    }
    const hasMore =
      matches.length > MAX_CHILDREN + 1 ||
      search?.isLast === false ||
      (typeof search?.nextPageToken === "string" && search.nextPageToken !== "")
    const observed = new Map<string, ObservedIssue>()
    const issues: JiraIssueView[] = []
    const warnings: string[] = []
    let conflict = hasMore
    let baseline: JiraPlanMarker | null = null
    for (const match of matches.slice(0, MAX_CHILDREN + 1)) {
      const id = numericId(record(match)?.id)
      if (!id) {
        conflict = true
        continue
      }
      const raw = await this.readIssue(id)
      const properties = record(raw.properties)
      const marker = this.parseMarker(properties?.[PROPERTY_KEY])
      const fields = record(raw.fields)
      const key = text(raw.key)
      const summary = text(fields?.summary)
      const issueType = record(fields?.issuetype)
      if (
        !marker ||
        !key ||
        !summary ||
        marker.sourcePageId !== sourcePageId ||
        !Array.isArray(fields?.labels) ||
        !fields.labels.includes(markerLabel)
      ) {
        conflict = true
        continue
      }
      if (
        baseline &&
        (baseline.planVersion !== marker.planVersion ||
          baseline.sourceLastEditedTime !== marker.sourceLastEditedTime ||
          JSON.stringify(baseline.expectedClientKeys) !==
            JSON.stringify(marker.expectedClientKeys) ||
          JSON.stringify(baseline.dependencies) !==
            JSON.stringify(marker.dependencies))
      ) {
        conflict = true
      }
      baseline ??= marker
      if (observed.has(marker.clientKey)) conflict = true
      const parent = record(fields?.parent)
      const assignee = record(fields?.assignee)
      const view: JiraIssueView = {
        clientKey: marker.clientKey,
        id,
        key,
        url: `${this.config.siteUrl}/browse/${encodeURIComponent(key)}`,
        summary: bounded(summary, 180),
        issueType: bounded(text(issueType?.name) ?? "Unknown", 200),
        assignee:
          typeof assignee?.displayName === "string"
            ? bounded(assignee.displayName, 200)
            : null,
        parentKey: text(parent?.key),
      }
      const entry = {
        ref: { id, key, url: view.url },
        view,
        marker,
      }
      observed.set(marker.clientKey, entry)
      issues.push(view)
    }
    issues.sort((left, right) => left.clientKey.localeCompare(right.clientKey))

    if (!baseline) {
      return {
        ok: !conflict,
        status: conflict ? "conflict" : "not_observed",
        source: null,
        project,
        planVersion: null,
        issues,
        dependencies: [],
        missingClientKeys: [],
        hasMore,
        warnings: [
          conflict
            ? "Jira returned marked issues that this Worker could not verify."
            : "Jira enhanced search is eventually consistent; no observed marker is not proof that a timed-out create did not succeed.",
        ],
        message: conflict
          ? "Marked Jira work could not be verified. Review it manually."
          : "No Jira work for this Notion page was observed.",
        nextAction: conflict ? "manual_review" : "inspect_again",
        observed,
      }
    }

    const missingClientKeys = baseline.expectedClientKeys.filter(
      (key) => !observed.has(key)
    )
    const epic = observed.get(baseline.expectedClientKeys[0])
    if (epic && epic.view.parentKey !== null) conflict = true
    if (epic) {
      for (const clientKey of baseline.expectedClientKeys.slice(1)) {
        const child = observed.get(clientKey)
        if (child && child.view.parentKey !== epic.ref.key) conflict = true
      }
    }
    const dependencies: JiraDependencyView[] = []
    for (const dependency of baseline.dependencies) {
      const blocker = observed.get(dependency.blockerClientKey)?.ref
      const blocked = observed.get(dependency.blockedClientKey)?.ref
      const exists =
        blocker && blocked
          ? await this.dependencyExists(blocker, blocked)
          : false
      dependencies.push({
        ...dependency,
        state: exists ? "existing" : "missing",
      })
    }
    if (hasMore) {
      warnings.push(
        "More marked Jira issues exist than this bounded recipe supports."
      )
    }
    const incomplete =
      missingClientKeys.length > 0 ||
      dependencies.some((dependency) => dependency.state === "missing")
    const status = conflict ? "conflict" : incomplete ? "partial" : "complete"
    return {
      ok: status === "complete",
      status,
      source: {
        pageId: sourcePageId,
        url: `https://www.notion.so/${sourcePageId}`,
        lastEditedTime: baseline.sourceLastEditedTime,
      },
      project,
      planVersion: baseline.planVersion,
      issues,
      dependencies,
      missingClientKeys,
      hasMore,
      warnings,
      message:
        status === "complete"
          ? "Jira contains the complete marked plan."
          : status === "partial"
            ? "Jira contains only part of the marked plan."
            : "Marked Jira work conflicts with the current source or marker contract.",
      nextAction:
        status === "complete"
          ? "none"
          : status === "partial"
            ? "inspect_again"
            : "manual_review",
      observed,
    }
  }

  private async readIssue(id: string): Promise<JsonRecord> {
    const query = new URLSearchParams({
      fields: [
        "project",
        "summary",
        "description",
        "issuetype",
        "parent",
        "labels",
        "assignee",
        "fixVersions",
        ...(this.config.estimateFieldId ? [this.config.estimateFieldId] : []),
      ].join(","),
      properties: PROPERTY_KEY,
    })
    const body = record(
      await this.readJson(
        `/rest/api/3/issue/${encodeURIComponent(id)}?${query.toString()}`
      )
    )
    if (!body) {
      throw new JiraError("Jira issue response was malformed", {
        kind: "unavailable",
        retryable: true,
      })
    }
    return body
  }

  private descriptionDocument(plan: PreparedPlan, node: PreparedNode): unknown {
    const content: unknown[] = []
    for (const line of node.description.split("\n")) {
      if (node.description === "" && line === "") break
      content.push({
        type: "paragraph",
        content: line === "" ? [] : [{ type: "text", text: line }],
      })
    }
    if (node.acceptanceCriteria !== "") {
      content.push({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Acceptance criteria",
            marks: [{ type: "strong" }],
          },
        ],
      })
      for (const line of node.acceptanceCriteria.split("\n")) {
        content.push({
          type: "paragraph",
          content: line === "" ? [] : [{ type: "text", text: line }],
        })
      }
    }
    content.push({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Source plan in Notion",
          marks: [{ type: "link", attrs: { href: plan.source.url } }],
        },
      ],
    })
    return { version: 1, type: "doc", content }
  }

  private async verifyExactNode(
    ref: IssueRef,
    plan: PreparedPlan,
    node: PreparedNode,
    parent: IssueRef | null
  ): Promise<void> {
    const issue = await this.readIssue(ref.id)
    const fields = record(issue.fields)
    const project = record(fields?.project)
    const issueType = record(fields?.issuetype)
    const observedParent = record(fields?.parent)
    const assignee = record(fields?.assignee)
    const properties = record(issue.properties)
    const labels = fields?.labels
    const versions = fields?.fixVersions
    const expectedMarker = this.marker(plan, node)
    const observedMarker = this.parseMarker(properties?.[PROPERTY_KEY])
    const observedVersionIds = Array.isArray(versions)
      ? versions
          .map((value) => numericId(record(value)?.id))
          .filter((value): value is string => value !== null)
      : []
    const expectedLabels = [
      ...node.labels,
      pageLabel(plan.source.pageId),
    ].sort()
    const observedLabels = Array.isArray(labels)
      ? labels
          .filter((value): value is string => typeof value === "string")
          .sort()
      : []
    if (
      text(issue.id) !== ref.id ||
      text(issue.key) !== ref.key ||
      numericId(project?.id) !== plan.project.id ||
      text(fields?.summary) !== node.summary ||
      JSON.stringify(fields?.description) !==
        JSON.stringify(this.descriptionDocument(plan, node)) ||
      numericId(issueType?.id) !== node.issueType.id ||
      numericId(observedParent?.id) !== (parent?.id ?? null) ||
      (node.assignee !== null &&
        text(assignee?.accountId) !== node.assignee.id) ||
      JSON.stringify(observedLabels) !== JSON.stringify(expectedLabels) ||
      (node.fixVersion !== null &&
        (observedVersionIds.length !== 1 ||
          observedVersionIds[0] !== node.fixVersion.id)) ||
      (node.estimate !== null &&
        plan.estimateFieldId !== null &&
        fields?.[plan.estimateFieldId] !== node.estimate) ||
      JSON.stringify(observedMarker) !== JSON.stringify(expectedMarker)
    ) {
      throw new JiraError(
        `${node.clientKey}: existing marked Jira work does not match the prepared plan`,
        { kind: "conflict" }
      )
    }
  }

  private async createNode(
    plan: PreparedPlan,
    node: PreparedNode,
    parent: IssueRef | null
  ): Promise<{ ref: IssueRef; requestId: string | null }> {
    const fields: Record<string, unknown> = {
      project: { id: plan.project.id },
      issuetype: { id: node.issueType.id },
      summary: node.summary,
      description: this.descriptionDocument(plan, node),
      labels: [...node.labels, pageLabel(plan.source.pageId)],
    }
    if (parent) fields.parent = { id: parent.id }
    if (node.assignee) fields.assignee = { accountId: node.assignee.id }
    if (node.fixVersion) fields.fixVersions = [{ id: node.fixVersion.id }]
    if (node.estimate !== null && plan.estimateFieldId) {
      fields[plan.estimateFieldId] = node.estimate
    }
    const response = await this.writeJson("/rest/api/3/issue", {
      fields,
      properties: [{ key: PROPERTY_KEY, value: this.marker(plan, node) }],
    })
    const body = record(response.data)
    const id = numericId(body?.id)
    const key = text(body?.key)
    if (!id || !key || !key.startsWith(`${plan.project.key}-`)) {
      throw new JiraError("Jira create response could not be verified", {
        kind: "ambiguous",
        retryable: true,
        mutationUnknown: true,
        requestId: response.requestId,
      })
    }
    const ref = {
      id,
      key,
      url: `${this.config.siteUrl}/browse/${encodeURIComponent(key)}`,
    }
    try {
      await this.verifyExactNode(ref, plan, node, parent)
    } catch {
      throw new JiraError("Jira created work could not be read back exactly", {
        kind: "ambiguous",
        retryable: true,
        mutationUnknown: true,
        requestId: response.requestId,
      })
    }
    return { ref, requestId: response.requestId }
  }

  private async dependencyExists(
    blocker: IssueRef,
    blocked: IssueRef
  ): Promise<boolean> {
    const query = new URLSearchParams({ fields: "issuelinks" })
    const issue = record(
      await this.readJson(
        `/rest/api/3/issue/${encodeURIComponent(blocker.id)}?${query.toString()}`
      )
    )
    const links = record(issue?.fields)?.issuelinks
    if (!Array.isArray(links)) {
      throw new JiraError("Jira dependency response was malformed", {
        kind: "unavailable",
        retryable: true,
      })
    }
    return links.some((value) => {
      const link = record(value)
      const type = record(link?.type)
      const outwardIssue = record(link?.outwardIssue)
      return (
        text(type?.id) === this.config.blocksLinkTypeId &&
        text(outwardIssue?.id) === blocked.id
      )
    })
  }

  private async createDependency(
    blocker: IssueRef,
    blocked: IssueRef
  ): Promise<{ requestId: string | null }> {
    const response = await this.writeJson(
      "/rest/api/3/issueLink",
      {
        type: { id: this.config.blocksLinkTypeId },
        outwardIssue: { id: blocker.id },
        inwardIssue: { id: blocked.id },
      },
      true
    )
    try {
      if (!(await this.dependencyExists(blocker, blocked))) {
        throw new Error("dependency not visible")
      }
    } catch {
      throw new JiraError("Jira dependency could not be read back", {
        kind: "ambiguous",
        retryable: true,
        mutationUnknown: true,
        requestId: response.requestId,
      })
    }
    return { requestId: response.requestId }
  }

  private async readJson(
    path: string,
    init: RequestInit = {}
  ): Promise<unknown> {
    let lastError: JiraError | null = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return (await this.request(path, { method: "GET", ...init }, false))
          .data
      } catch (error) {
        if (
          !(error instanceof JiraError) ||
          !error.retryable ||
          attempt === 1
        ) {
          throw error
        }
        lastError = error
        const delay = Math.min(2_000, (error.retryAfterSeconds ?? 0) * 1_000)
        if (delay > 0) await this.sleep(delay)
      }
    }
    throw (
      lastError ?? new JiraError("Jira read failed", { kind: "unavailable" })
    )
  }

  private writeJson(
    path: string,
    body: unknown,
    allowEmpty = false
  ): Promise<ApiResponse<unknown>> {
    return this.request(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      true,
      allowEmpty
    )
  }

  private async request(
    path: string,
    init: RequestInit,
    mutation: boolean,
    allowEmpty = false
  ): Promise<ApiResponse<unknown>> {
    this.calls += 1
    if (this.calls > MAX_CALLS) {
      throw new JiraError("Jira call ceiling exceeded", {
        kind: "conflict",
      })
    }
    const remainingMs = MAX_EXECUTION_MS - (this.now() - this.startedAt)
    if (remainingMs <= 0) {
      throw new JiraError("Jira execution time budget was exhausted", {
        kind: "unavailable",
        retryable: true,
      })
    }
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(REQUEST_TIMEOUT_MS, remainingMs)
    )
    try {
      const response = await this.fetch(
        `https://api.atlassian.com/ex/jira/${this.config.cloudId}${path}`,
        {
          ...init,
          signal: controller.signal,
          redirect: "error",
          headers: {
            Accept: "application/json",
            Authorization: `Basic ${Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString("base64")}`,
            ...init.headers,
          },
        }
      )
      if (!response.ok) {
        await discardBody(response)
        throw httpError(response, mutation ? path : null)
      }
      const providerRequestId = requestId(response)
      if (
        response.status === 204 ||
        response.headers.get("content-length") === "0"
      ) {
        return { data: null, requestId: providerRequestId }
      }
      const body = await readBoundedBody(response, mutation)
      if (body === "" && allowEmpty) {
        return { data: null, requestId: providerRequestId }
      }
      try {
        return { data: JSON.parse(body), requestId: providerRequestId }
      } catch {
        if (mutation) {
          throw new JiraError("Jira mutation response could not be verified", {
            kind: "ambiguous",
            retryable: true,
            mutationUnknown: true,
            requestId: providerRequestId,
          })
        }
        throw new JiraError("Jira response was not valid JSON", {
          kind: "unavailable",
          retryable: true,
          requestId: providerRequestId,
        })
      }
    } catch (error) {
      if (error instanceof JiraError) throw error
      throw new JiraError(
        mutation
          ? "Jira mutation outcome is unknown"
          : "Jira read was unavailable",
        {
          kind: mutation ? "ambiguous" : "unavailable",
          retryable: true,
          mutationUnknown: mutation,
        }
      )
    } finally {
      clearTimeout(timer)
    }
  }
}
