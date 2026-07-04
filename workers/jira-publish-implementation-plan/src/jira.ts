import type { RuntimeConfig } from "./config.js"
import {
  boundedRetryAfterSeconds,
  MAX_NODES,
  normalizePageId,
} from "./policy.js"
import type { PlanNode, ProjectPolicy } from "./types.js"

type Fetch = typeof globalThis.fetch
type JsonRecord = Record<string, unknown>
const MAX_RESPONSE_BYTES = 1_000_000

export type JiraIssueRef = {
  id: string
  key: string
  url: string
}

export type CreateNodeInput = {
  operationId: string
  planHash: string
  approvalPageId: string
  project: ProjectPolicy
  node: PlanNode
  marker: string
  parent: JiraIssueRef | null
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
  readonly mutationDefinitelyRejected: boolean
  readonly mutationRequestNotSent: boolean

  constructor(
    message: string,
    options: {
      kind: JiraError["kind"]
      retryable?: boolean
      retryAfterSeconds?: number | null
      mutationUnknown?: boolean
      mutationDefinitelyRejected?: boolean
      mutationRequestNotSent?: boolean
    }
  ) {
    super(message)
    this.name = "JiraError"
    this.kind = options.kind
    this.retryable = options.retryable ?? false
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
    this.mutationUnknown = options.mutationUnknown ?? false
    this.mutationDefinitelyRejected =
      options.mutationDefinitelyRejected ?? false
    this.mutationRequestNotSent = options.mutationRequestNotSent ?? false
  }
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function numericId(value: unknown): string | null {
  const result = string(value)
  return result && /^[1-9][0-9]{0,31}$/.test(result) ? result : null
}

function sprintIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  const result: number[] = []
  for (const raw of value) {
    const id = record(raw)?.id
    const numeric = typeof id === "number" ? id : Number(string(id))
    if (!Number.isSafeInteger(numeric) || numeric <= 0) return null
    result.push(numeric)
  }
  return result
}

function parseRetryAfter(response: Response): number | null {
  const value = response.headers.get("retry-after")
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return boundedRetryAfterSeconds(seconds)
  const date = Date.parse(value)
  return Number.isNaN(date)
    ? null
    : boundedRetryAfterSeconds((date - Date.now()) / 1_000)
}

function httpError(response: Response, mutationPath: string | null): JiraError {
  const status = response.status
  const retryAfterSeconds = parseRetryAfter(response)
  if (mutationPath !== null) {
    const documentedDefiniteRejections: Record<string, Set<number>> = {
      "/rest/api/3/issue": new Set([400, 401, 403, 422]),
      "/rest/api/3/issueLink": new Set([400, 401, 404, 413]),
    }
    if (!documentedDefiniteRejections[mutationPath]?.has(status)) {
      return new JiraError(
        `Jira mutation outcome is unknown (HTTP ${status})`,
        {
          kind: "ambiguous",
          // The provider POST is never repeated. `retryable` means an
          // identical caller replay may safely reconcile the durable fence.
          retryable: true,
          retryAfterSeconds,
          mutationUnknown: true,
        }
      )
    }
  }
  const mutationOptions =
    mutationPath === null ? {} : { mutationDefinitelyRejected: true }
  if (status === 401) {
    return new JiraError("Jira authentication failed (HTTP 401)", {
      kind: "auth",
      ...mutationOptions,
    })
  }
  if (status === 403) {
    return new JiraError("Jira denied the operation (HTTP 403)", {
      kind: "forbidden",
      ...mutationOptions,
    })
  }
  if (status === 404) {
    return new JiraError("Jira resource was not found (HTTP 404)", {
      kind: "not_found",
      ...mutationOptions,
    })
  }
  if (status === 429) {
    return new JiraError("Jira rate limited the operation (HTTP 429)", {
      kind: "rate_limited",
      retryable: true,
      retryAfterSeconds,
      ...mutationOptions,
    })
  }
  if ([400, 409, 412, 422].includes(status)) {
    return new JiraError(`Jira rejected current state (HTTP ${status})`, {
      kind: "conflict",
      ...mutationOptions,
    })
  }
  return new JiraError(`Jira request failed (HTTP ${status})`, {
    kind: "unavailable",
    retryable: status >= 500 || status === 408,
    ...mutationOptions,
  })
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

async function readBoundedBody(response: Response): Promise<string> {
  const declared = response.headers.get("content-length")
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
    await discardBody(response)
    throw new JiraError("Jira response exceeded the fixed body limit", {
      kind: "unavailable",
      retryable: true,
    })
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new JiraError("Jira response exceeded the fixed body limit", {
        kind: "unavailable",
        retryable: true,
      })
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

type IssueTypeMeta = { id: string; name: string; subtask: boolean }
type FieldSchema = {
  type: string
  items: string | null
  custom: string | null
  customId: number | null
}
type FieldMeta = {
  fieldId: string
  key: string
  required: boolean
  hasDefaultValue: boolean
  operations: string[]
  allowedValues: unknown[]
  schema: FieldSchema
}

export class JiraClient {
  private readonly fetch: Fetch
  private readonly sleep: (ms: number) => Promise<void>
  private calls = 0
  private readonly startedAtMs: number
  private readonly now: () => number
  // Worst-case fresh publication: 75 metadata/user reads, 45 node
  // search/create/verification calls, and 90 dependency read/write/read calls.
  // Headroom covers bounded read retries without making the client unbounded.
  static readonly MAX_CALLS = 256
  static readonly MAX_EXECUTION_MS = 55_000
  static readonly PROPERTY_KEY = "notion.cookbook.plan-node"

  constructor(
    private readonly config: RuntimeConfig,
    options: {
      fetch?: Fetch
      sleep?: (ms: number) => Promise<void>
      now?: () => number
    } = {}
  ) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.startedAtMs = this.now()
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  get callCount(): number {
    return this.calls
  }

  async preflight(project: ProjectPolicy, nodes: PlanNode[]): Promise<void> {
    await this.verifySiteAndProject(project)
    const types = await this.fetchIssueTypes(project)
    const nodesByType = new Map<string, PlanNode[]>()
    for (const node of nodes) {
      const list = nodesByType.get(node.issueTypeId) ?? []
      list.push(node)
      nodesByType.set(node.issueTypeId, list)
    }
    const byKey = new Map(nodes.map((node) => [node.nodeKey, node]))
    for (const [issueTypeId, typedNodes] of nodesByType) {
      const issueType = types.get(issueTypeId)
      if (!issueType) {
        throw new JiraError(
          `Configured issue type ${issueTypeId} is not currently creatable`,
          { kind: "conflict" }
        )
      }
      for (const node of typedNodes) {
        if (
          issueType.subtask !==
          (node.parentNodeKey !== null && this.depth(node, byKey) === 2)
        ) {
          if (issueType.subtask && node.parentNodeKey === null) {
            throw new JiraError(
              `${node.nodeKey}: subtask issue type needs a parent`,
              {
                kind: "conflict",
              }
            )
          }
          if (
            node.parentNodeKey !== null &&
            this.depth(node, byKey) === 2 &&
            !issueType.subtask
          ) {
            throw new JiraError(
              `${node.nodeKey}: depth-two child must use a current subtask issue type`,
              { kind: "conflict" }
            )
          }
        }
      }
      const fields = await this.fetchFields(project, issueTypeId)
      this.validateFields(project, typedNodes, fields)
    }
    for (const node of nodes) {
      if (
        types.get(node.issueTypeId)?.subtask &&
        nodes.some((item) => item.parentNodeKey === node.nodeKey)
      ) {
        throw new JiraError(
          `${node.nodeKey}: a subtask cannot parent another node`,
          {
            kind: "conflict",
          }
        )
      }
    }
    await this.verifyLinkType()
    const assignees = [
      ...new Set(
        nodes
          .map((node) => node.assigneeAccountId)
          .filter((value): value is string => value !== null)
      ),
    ].sort()
    for (const accountId of assignees) {
      await this.verifyUser(accountId)
      await this.verifyAssignableUser(project, accountId)
    }
  }

  async findNode(input: CreateNodeInput): Promise<JiraIssueRef | null> {
    const jql = `project = \"${input.project.projectKey}\" AND labels = \"${input.marker}\" ORDER BY id ASC`
    const query = new URLSearchParams({
      jql,
      maxResults: "2",
      fields: "id,key",
    })
    const page = record(
      await this.readJson(`/rest/api/3/search/jql?${query.toString()}`)
    )
    const issues = page?.issues
    if (!page || !Array.isArray(issues)) {
      throw new JiraError("Jira search response was malformed", {
        kind: "unavailable",
        retryable: true,
      })
    }
    const hasNextToken = Object.hasOwn(page, "nextPageToken")
    const nextToken = page.nextPageToken
    if (
      (hasNextToken &&
        nextToken !== null &&
        nextToken !== undefined &&
        (typeof nextToken !== "string" || nextToken.length > 0)) ||
      page.isLast !== true
    ) {
      throw new JiraError(
        `${input.node.nodeKey}: marker search did not return a final page`,
        { kind: "unavailable", retryable: true }
      )
    }
    if (issues.length === 0) return null
    if (issues.length > 1) {
      throw new JiraError(
        `${input.node.nodeKey}: marker matched multiple Jira issues`,
        {
          kind: "conflict",
        }
      )
    }
    const issue = record(issues[0])
    const id = numericId(issue?.id)
    const key = string(issue?.key)
    if (!id || !key) {
      throw new JiraError("Jira search returned an invalid issue identity", {
        kind: "unavailable",
        retryable: true,
      })
    }
    await this.verifyExistingNode(id, key, input)
    return this.issueRef(id, key)
  }

  async createNode(input: CreateNodeInput): Promise<JiraIssueRef> {
    const fields: Record<string, unknown> = {
      project: { id: input.project.projectId },
      issuetype: { id: input.node.issueTypeId },
      summary: input.node.summary,
      description: this.descriptionDocument(input),
      labels: [...input.node.labels, input.marker],
    }
    if (input.parent) fields.parent = { id: input.parent.id }
    if (input.node.assigneeAccountId) {
      fields.assignee = { accountId: input.node.assigneeAccountId }
    }
    if (input.node.fixVersionId) {
      fields.fixVersions = [{ id: input.node.fixVersionId }]
    }
    if (input.node.estimatePoints !== null && input.project.fieldIds.estimate) {
      fields[input.project.fieldIds.estimate] = input.node.estimatePoints
    }
    if (input.node.sprintId !== null && input.project.fieldIds.sprint) {
      fields[input.project.fieldIds.sprint] = input.node.sprintId
    }

    const response = record(
      await this.writeJson("/rest/api/3/issue", {
        fields,
        properties: [
          {
            key: JiraClient.PROPERTY_KEY,
            value: {
              version: 1,
              operationId: input.operationId,
              planHash: input.planHash,
              sourcePageId: normalizePageId(input.approvalPageId),
              nodeKey: input.node.nodeKey,
            },
          },
        ],
      })
    )
    const id = numericId(response?.id)
    const key = string(response?.key)
    if (!id || !key || !key.startsWith(`${input.project.projectKey}-`)) {
      throw new JiraError(
        "Jira create response had an invalid issue identity",
        {
          kind: "ambiguous",
          retryable: true,
          mutationUnknown: true,
        }
      )
    }
    try {
      await this.verifyExistingNode(id, key, input)
    } catch {
      throw new JiraError("Jira created issue could not be verified exactly", {
        kind: "ambiguous",
        retryable: true,
        mutationUnknown: true,
      })
    }
    return this.issueRef(id, key)
  }

  async dependencyExists(
    blocker: JiraIssueRef,
    blocked: JiraIssueRef
  ): Promise<boolean> {
    const query = new URLSearchParams({ fields: "issuelinks" })
    const issue = record(
      await this.readJson(
        `/rest/api/3/issue/${encodeURIComponent(blocker.id)}?${query.toString()}`
      )
    )
    const fields = record(issue?.fields)
    const links = fields?.issuelinks
    if (!Array.isArray(links)) {
      throw new JiraError("Jira issue-link response was malformed", {
        kind: "unavailable",
        retryable: true,
      })
    }
    return links.some((value) => {
      const link = record(value)
      const type = record(link?.type)
      const outward = record(link?.outwardIssue)
      return (
        string(type?.id) === this.config.dependencyLinkTypeId &&
        string(outward?.id) === blocked.id
      )
    })
  }

  async createDependency(
    blocker: JiraIssueRef,
    blocked: JiraIssueRef
  ): Promise<void> {
    await this.writeJson(
      "/rest/api/3/issueLink",
      {
        type: {
          id: this.config.dependencyLinkTypeId,
          name: this.config.dependencyLinkTypeName,
        },
        outwardIssue: { id: blocker.id },
        inwardIssue: { id: blocked.id },
      },
      true
    )
  }

  private depth(node: PlanNode, byKey: Map<string, PlanNode>): number {
    let depth = 0
    let current = node
    while (current.parentNodeKey !== null) {
      depth += 1
      current = byKey.get(current.parentNodeKey) as PlanNode
    }
    return depth
  }

  private async fetchIssueTypes(
    project: ProjectPolicy
  ): Promise<Map<string, IssueTypeMeta>> {
    const result = new Map<string, IssueTypeMeta>()
    let startAt = 0
    for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
      const query = new URLSearchParams({
        startAt: String(startAt),
        maxResults: "50",
      })
      const page = record(
        await this.readJson(
          `/rest/api/3/issue/createmeta/${project.projectId}/issuetypes?${query.toString()}`
        )
      )
      const values = page?.issueTypes
      if (!Array.isArray(values)) {
        throw new JiraError("Jira issue-type metadata was malformed", {
          kind: "unavailable",
          retryable: true,
        })
      }
      for (const value of values) {
        const item = record(value)
        const id = numericId(item?.id)
        const name = string(item?.name)
        if (!id || !name || typeof item?.subtask !== "boolean") {
          throw new JiraError("Jira issue-type metadata had invalid fields", {
            kind: "unavailable",
            retryable: true,
          })
        }
        if (result.has(id)) {
          throw new JiraError("Jira issue-type metadata contained duplicates", {
            kind: "unavailable",
            retryable: true,
          })
        }
        result.set(id, { id, name, subtask: item.subtask })
      }
      const total = Number(page?.total)
      const maxResults = Number(page?.maxResults)
      const observedStart = Number(page?.startAt)
      if (
        !Number.isSafeInteger(total) ||
        !Number.isSafeInteger(maxResults) ||
        maxResults < 1 ||
        observedStart !== startAt
      ) {
        throw new JiraError("Jira issue-type pagination was malformed", {
          kind: "unavailable",
          retryable: true,
        })
      }
      startAt += values.length
      if (startAt >= total) return result
      if (values.length === 0) break
    }
    throw new JiraError("Jira issue-type metadata exceeded four pages", {
      kind: "conflict",
    })
  }

  private async fetchFields(
    project: ProjectPolicy,
    issueTypeId: string
  ): Promise<Map<string, FieldMeta>> {
    const result = new Map<string, FieldMeta>()
    let startAt = 0
    for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
      const query = new URLSearchParams({
        startAt: String(startAt),
        maxResults: "50",
      })
      const page = record(
        await this.readJson(
          `/rest/api/3/issue/createmeta/${project.projectId}/issuetypes/${issueTypeId}?${query.toString()}`
        )
      )
      const values = page?.fields
      if (!Array.isArray(values)) {
        throw new JiraError("Jira create-field metadata was malformed", {
          kind: "unavailable",
          retryable: true,
        })
      }
      for (const value of values) {
        const item = record(value)
        const fieldId = string(item?.fieldId)
        const key = string(item?.key)
        const operations = item?.operations
        const allowedValues = item?.allowedValues ?? []
        const schema = record(item?.schema)
        const schemaType = string(schema?.type)
        const schemaItems =
          schema?.items === undefined ? null : string(schema.items)
        const schemaCustom =
          schema?.custom === undefined ? null : string(schema.custom)
        const schemaCustomId =
          schema?.customId === undefined ? null : schema.customId
        if (
          !fieldId ||
          !key ||
          typeof item?.required !== "boolean" ||
          typeof item?.hasDefaultValue !== "boolean" ||
          !Array.isArray(operations) ||
          operations.some((entry) => typeof entry !== "string") ||
          !Array.isArray(allowedValues) ||
          !schemaType ||
          (schema?.items !== undefined && schemaItems === null) ||
          (schema?.custom !== undefined && schemaCustom === null) ||
          (schemaCustomId !== null &&
            (typeof schemaCustomId !== "number" ||
              !Number.isSafeInteger(schemaCustomId) ||
              schemaCustomId < 1))
        ) {
          throw new JiraError("Jira create-field metadata had invalid fields", {
            kind: "unavailable",
            retryable: true,
          })
        }
        result.set(fieldId, {
          fieldId,
          key,
          required: item.required,
          hasDefaultValue: item.hasDefaultValue,
          operations: operations as string[],
          allowedValues,
          schema: {
            type: schemaType,
            items: schemaItems,
            custom: schemaCustom,
            customId: schemaCustomId as number | null,
          },
        })
      }
      const total = Number(page?.total)
      const maxResults = Number(page?.maxResults)
      const observedStart = Number(page?.startAt)
      if (
        !Number.isSafeInteger(total) ||
        !Number.isSafeInteger(maxResults) ||
        maxResults < 1 ||
        observedStart !== startAt
      ) {
        throw new JiraError("Jira create-field pagination was malformed", {
          kind: "unavailable",
          retryable: true,
        })
      }
      startAt += values.length
      if (startAt >= total) return result
      if (values.length === 0) break
    }
    throw new JiraError("Jira create-field metadata exceeded four pages", {
      kind: "conflict",
    })
  }

  private validateFields(
    project: ProjectPolicy,
    nodes: PlanNode[],
    fields: Map<string, FieldMeta>
  ): void {
    const always = new Set(["project", "issuetype", "summary", "description"])
    const optional = new Map<string, (node: PlanNode) => boolean>([
      ["parent", (node) => node.parentNodeKey !== null],
      ["assignee", (node) => node.assigneeAccountId !== null],
      ["labels", () => true],
      ["fixVersions", (node) => node.fixVersionId !== null],
    ])
    if (project.fieldIds.estimate) {
      optional.set(
        project.fieldIds.estimate,
        (node) => node.estimatePoints !== null
      )
    }
    if (project.fieldIds.sprint) {
      optional.set(project.fieldIds.sprint, (node) => node.sprintId !== null)
    }

    for (const [fieldId, predicate] of optional) {
      if (!nodes.some(predicate)) continue
      const meta = fields.get(fieldId)
      if (!meta || !meta.operations.includes("set")) {
        throw new JiraError(
          `Current create metadata does not allow field ${fieldId}`,
          {
            kind: "conflict",
          }
        )
      }
    }
    for (const fieldId of always) {
      const meta = fields.get(fieldId)
      if (!meta || !meta.operations.includes("set")) {
        throw new JiraError(
          `Current create metadata does not allow field ${fieldId}`,
          {
            kind: "conflict",
          }
        )
      }
    }
    for (const meta of fields.values()) {
      if (!meta.required || meta.hasDefaultValue) continue
      if (always.has(meta.fieldId)) continue
      const predicate = optional.get(meta.fieldId)
      if (!predicate || nodes.some((node) => !predicate(node))) {
        throw new JiraError(
          `Required Jira field ${meta.fieldId} is not supplied for every node of this type`,
          { kind: "conflict" }
        )
      }
    }
    if (
      project.fieldIds.estimate &&
      nodes.some((node) => node.estimatePoints !== null)
    ) {
      this.assertConfiguredFieldSchema(
        fields.get(project.fieldIds.estimate),
        project.fieldIds.estimate,
        "estimate"
      )
    }
    if (
      project.fieldIds.sprint &&
      nodes.some((node) => node.sprintId !== null)
    ) {
      this.assertConfiguredFieldSchema(
        fields.get(project.fieldIds.sprint),
        project.fieldIds.sprint,
        "sprint"
      )
    }
    this.assertCurrentlyAllowed(
      fields.get("fixVersions"),
      nodes
        .map((node) => node.fixVersionId)
        .filter((value): value is string => value !== null),
      "fix version"
    )
    if (project.fieldIds.sprint) {
      this.assertCurrentlyAllowed(
        fields.get(project.fieldIds.sprint),
        nodes
          .map((node) => node.sprintId)
          .filter((value): value is number => value !== null)
          .map(String),
        "sprint"
      )
    }
  }

  private assertCurrentlyAllowed(
    metadata: FieldMeta | undefined,
    expectedIds: string[],
    label: string
  ): void {
    if (expectedIds.length === 0) return
    if (!metadata || metadata.allowedValues.length === 0) {
      throw new JiraError(
        `Current create metadata did not confirm ${label} selectability`,
        { kind: "conflict" }
      )
    }
    const allowed = new Set(
      metadata.allowedValues
        .map((value) => {
          const item = record(value)
          const id = item?.id
          return typeof id === "number" ? String(id) : string(id)
        })
        .filter((value): value is string => value !== null)
    )
    for (const id of expectedIds) {
      if (!allowed.has(id)) {
        throw new JiraError(
          `Configured ${label} ${id} is not currently allowed`,
          {
            kind: "conflict",
          }
        )
      }
    }
  }

  private assertConfiguredFieldSchema(
    metadata: FieldMeta | undefined,
    fieldId: string,
    kind: "estimate" | "sprint"
  ): void {
    const customId = /^customfield_([1-9][0-9]{0,15})$/.exec(fieldId)?.[1]
    if (
      !metadata ||
      !customId ||
      metadata.schema.customId !== Number(customId)
    ) {
      throw new JiraError(
        `Configured ${kind} field ${fieldId} does not match its current Jira schema`,
        { kind: "conflict" }
      )
    }
    const valid =
      kind === "estimate"
        ? metadata.schema.type === "number"
        : metadata.schema.type === "array" &&
          metadata.schema.items === "json" &&
          metadata.schema.custom === "com.pyxis.greenhopper.jira:gh-sprint"
    if (!valid) {
      throw new JiraError(
        `Configured ${kind} field ${fieldId} has incompatible Jira semantics`,
        { kind: "conflict" }
      )
    }
  }

  private async verifyLinkType(): Promise<void> {
    const response = record(await this.readJson("/rest/api/3/issueLinkType"))
    const values = response?.issueLinkTypes
    if (!Array.isArray(values)) {
      throw new JiraError("Jira link-type response was malformed", {
        kind: "unavailable",
        retryable: true,
      })
    }
    const match = values.find((value) => {
      const item = record(value)
      return string(item?.id) === this.config.dependencyLinkTypeId
    })
    const item = record(match)
    if (string(item?.name) !== this.config.dependencyLinkTypeName) {
      throw new JiraError(
        "Configured dependency link type no longer matches Jira",
        {
          kind: "conflict",
        }
      )
    }
  }

  private async verifySiteAndProject(project: ProjectPolicy): Promise<void> {
    const server = record(await this.readJson("/rest/api/3/serverInfo"))
    const observedBaseUrl = string(server?.baseUrl)?.replace(/\/$/, "")
    if (observedBaseUrl !== this.config.siteUrl.replace(/\/$/, "")) {
      throw new JiraError(
        "Configured Jira site URL does not match the current cloud site",
        { kind: "conflict" }
      )
    }
    const observed = record(
      await this.readJson(
        `/rest/api/3/project/${encodeURIComponent(project.projectId)}`
      )
    )
    if (
      numericId(observed?.id) !== project.projectId ||
      string(observed?.key) !== project.projectKey
    ) {
      throw new JiraError(
        "Configured Jira project ID/key pair no longer matches",
        { kind: "conflict" }
      )
    }
  }

  private async verifyUser(accountId: string): Promise<void> {
    const query = new URLSearchParams({ accountId })
    const user = record(
      await this.readJson(`/rest/api/3/user?${query.toString()}`)
    )
    if (string(user?.accountId) !== accountId || user?.active !== true) {
      throw new JiraError("An approved assignee is missing or inactive", {
        kind: "conflict",
      })
    }
  }

  private async verifyAssignableUser(
    project: ProjectPolicy,
    accountId: string
  ): Promise<void> {
    const query = new URLSearchParams({
      project: project.projectKey,
      accountId,
      maxResults: "2",
    })
    const response = await this.readJson(
      `/rest/api/3/user/assignable/search?${query.toString()}`
    )
    if (
      !Array.isArray(response) ||
      response.length !== 1 ||
      string(record(response[0])?.accountId) !== accountId ||
      record(response[0])?.active !== true
    ) {
      throw new JiraError(
        "An approved assignee is not currently assignable to the project",
        { kind: "conflict" }
      )
    }
  }

  private async verifyExistingNode(
    id: string,
    key: string,
    input: CreateNodeInput
  ): Promise<void> {
    const requestedFields = [
      "summary",
      "description",
      "issuetype",
      "parent",
      "labels",
      "assignee",
      "fixVersions",
      input.project.fieldIds.estimate,
      input.project.fieldIds.sprint,
    ].filter((value): value is string => value !== null)
    const query = new URLSearchParams({
      fields: requestedFields.join(","),
      properties: JiraClient.PROPERTY_KEY,
    })
    const issue = record(
      await this.readJson(`/rest/api/3/issue/${id}?${query.toString()}`)
    )
    const fields = record(issue?.fields)
    const issueType = record(fields?.issuetype)
    const parent = record(fields?.parent)
    const assignee = record(fields?.assignee)
    const properties = record(issue?.properties)
    const property = record(properties?.[JiraClient.PROPERTY_KEY])
    const labels = fields?.labels
    const versions = fields?.fixVersions
    const parentId = input.parent?.id ?? null
    const observedParentId = numericId(parent?.id)
    const observedAssignee = string(assignee?.accountId)
    const observedVersions = Array.isArray(versions)
      ? versions.map((value) => string(record(value)?.id)).filter(Boolean)
      : []
    const observedSprintIds = input.project.fieldIds.sprint
      ? sprintIds(fields?.[input.project.fieldIds.sprint])
      : []
    if (
      string(issue?.id) !== id ||
      string(issue?.key) !== key ||
      string(fields?.summary) !== input.node.summary ||
      JSON.stringify(fields?.description) !==
        JSON.stringify(this.descriptionDocument(input)) ||
      string(issueType?.id) !== input.node.issueTypeId ||
      observedParentId !== parentId ||
      (input.node.assigneeAccountId !== null &&
        observedAssignee !== input.node.assigneeAccountId) ||
      !Array.isArray(labels) ||
      labels.length !== input.node.labels.length + 1 ||
      ![...input.node.labels, input.marker].every((label) =>
        labels.includes(label)
      ) ||
      (input.node.fixVersionId !== null &&
        observedVersions.join("\u0000") !== input.node.fixVersionId) ||
      property?.version !== 1 ||
      property?.operationId !== input.operationId ||
      property?.planHash !== input.planHash ||
      property?.sourcePageId !== normalizePageId(input.approvalPageId) ||
      property?.nodeKey !== input.node.nodeKey ||
      (input.project.fieldIds.estimate &&
        input.node.estimatePoints !== null &&
        fields?.[input.project.fieldIds.estimate] !==
          input.node.estimatePoints) ||
      (input.project.fieldIds.sprint &&
        input.node.sprintId !== null &&
        (!observedSprintIds ||
          !observedSprintIds.includes(input.node.sprintId)))
    ) {
      throw new JiraError(
        `${input.node.nodeKey}: existing marked issue has drifted`,
        {
          kind: "conflict",
        }
      )
    }
  }

  private descriptionDocument(input: CreateNodeInput): unknown {
    const content: unknown[] = []
    if (input.node.description.length > 0) {
      for (const line of input.node.description.split("\n")) {
        content.push({
          type: "paragraph",
          content: line.length > 0 ? [{ type: "text", text: line }] : [],
        })
      }
    }
    const sourceUrl = `https://www.notion.so/${normalizePageId(input.approvalPageId)}`
    content.push({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Approved implementation plan in Notion",
          marks: [{ type: "link", attrs: { href: sourceUrl } }],
        },
      ],
    })
    content.push({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: `Publication ${input.operationId}; node ${input.node.nodeKey}`,
        },
      ],
    })
    return { version: 1, type: "doc", content }
  }

  private issueRef(id: string, key: string): JiraIssueRef {
    return {
      id,
      key,
      url: `${this.config.siteUrl}/browse/${encodeURIComponent(key)}`,
    }
  }

  private async readJson(path: string): Promise<unknown> {
    let lastError: JiraError | null = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.request(path, { method: "GET" }, false)
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
  ): Promise<unknown> {
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
  ): Promise<unknown> {
    this.calls += 1
    if (this.calls > JiraClient.MAX_CALLS) {
      throw new JiraError("Jira call ceiling exceeded", {
        kind: "conflict",
        mutationDefinitelyRejected: mutation,
        mutationRequestNotSent: mutation,
      })
    }
    const remainingMs =
      JiraClient.MAX_EXECUTION_MS - (this.now() - this.startedAtMs)
    if (remainingMs <= 0) {
      throw new JiraError("Jira execution time budget was exhausted", {
        kind: "unavailable",
        retryable: true,
        mutationDefinitelyRejected: mutation,
        mutationRequestNotSent: mutation,
      })
    }
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(this.config.jiraRequestTimeoutMs, remainingMs)
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
      if (
        response.status === 204 ||
        response.headers.get("content-length") === "0"
      ) {
        return null
      }
      const responseText = await readBoundedBody(response)
      if (responseText === "" && allowEmpty) return null
      try {
        return JSON.parse(responseText)
      } catch {
        if (mutation) {
          throw new JiraError("Jira mutation response could not be verified", {
            kind: "ambiguous",
            retryable: true,
            mutationUnknown: true,
          })
        }
        throw new JiraError("Jira response was not valid JSON", {
          kind: "unavailable",
          retryable: true,
        })
      }
    } catch (error) {
      if (error instanceof JiraError) {
        if (
          mutation &&
          !error.mutationUnknown &&
          !error.mutationDefinitelyRejected
        ) {
          throw new JiraError("Jira mutation response could not be verified", {
            kind: "ambiguous",
            retryable: true,
            mutationUnknown: true,
          })
        }
        throw error
      }
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

export function assertNodeCeilingForProvider(nodes: PlanNode[]): void {
  if (nodes.length > MAX_NODES) {
    throw new JiraError("Plan exceeds provider call budget", {
      kind: "conflict",
    })
  }
}
