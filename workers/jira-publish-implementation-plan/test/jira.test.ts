import assert from "node:assert/strict"
import test from "node:test"

import type { RuntimeConfig } from "../src/config.js"
import { JiraClient, JiraError } from "../src/jira.js"
import { buildPlanVersion, pageLabel, preparedNodes } from "../src/plan.js"
import type {
  DraftNode,
  DraftPlan,
  JiraPlanMarker,
  PageSnapshot,
  PreparedNode,
  PreparedPlan,
  PreparedPlanData,
} from "../src/types.js"

const PAGE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const SITE_URL = "https://example.atlassian.net"

const config: RuntimeConfig = {
  cloudId: "00000000-0000-0000-0000-000000000000",
  siteUrl: SITE_URL,
  email: "worker@example.com",
  apiToken: "test-token",
  projectId: "100",
  projectKey: "ENG",
  blocksLinkTypeId: "10000",
  estimateFieldId: "customfield_10016",
}

const source: PageSnapshot = {
  pageId: PAGE_ID,
  url: `https://www.notion.so/${PAGE_ID}`,
  lastEditedTime: "2026-07-05T12:00:00.000Z",
}

type CapturedRequest = {
  url: URL
  method: string
  body: unknown
}

type FetchHandler = (
  request: CapturedRequest,
  init: RequestInit
) => Response | Promise<Response>

function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function capturedFetch(
  handler: FetchHandler,
  requests: CapturedRequest[] = []
): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const apiPrefix = `/ex/jira/${config.cloudId}`
    if (
      url.hostname === "api.atlassian.com" &&
      url.pathname.startsWith(apiPrefix)
    ) {
      url.pathname = url.pathname.slice(apiPrefix.length)
    }
    const method = (init.method ?? "GET").toUpperCase()
    const body =
      typeof init.body === "string" && init.body !== ""
        ? JSON.parse(init.body)
        : null
    const request = { url, method, body }
    requests.push(request)
    return handler(request, init)
  }) as typeof fetch
}

function node(
  clientKey: string,
  issueTypeName: string,
  overrides: Partial<DraftNode> = {}
): DraftNode {
  return {
    clientKey,
    summary: `${clientKey} summary`,
    description: `${clientKey} description`,
    acceptanceCriteria: `${clientKey} is accepted`,
    issueTypeName,
    issueTypeId: null,
    assigneeName: null,
    assigneeAccountId: null,
    labels: ["implementation"],
    estimate: null,
    fixVersionName: null,
    fixVersionId: null,
    ...overrides,
  }
}

function draftPlan(overrides: Partial<DraftPlan> = {}): DraftPlan {
  return {
    sourcePageId: PAGE_ID,
    epic: node("delivery", "Epic", { labels: ["plan"] }),
    children: [
      node("api", "Story", {
        assigneeName: "Ada Lovelace",
        assigneeAccountId: "ada-account",
        fixVersionName: "Release 1",
      }),
      node("ui", "Task"),
    ],
    dependencies: [{ blockerClientKey: "api", blockedClientKey: "ui" }],
    ...overrides,
  }
}

function field(
  fieldId: string,
  schemaType: string,
  options: {
    allowedValues?: unknown[]
    required?: boolean
    hasDefaultValue?: boolean
    customId?: number
  } = {}
): unknown {
  return {
    fieldId,
    required: options.required ?? false,
    hasDefaultValue: options.hasDefaultValue ?? false,
    operations: ["set"],
    allowedValues: options.allowedValues ?? [],
    schema: {
      type: schemaType,
      ...(options.customId === undefined ? {} : { customId: options.customId }),
    },
  }
}

function createFields(): unknown[] {
  return [
    field("project", "project"),
    field("issuetype", "issuetype"),
    field("summary", "string"),
    field("description", "string"),
    field("labels", "array"),
    field("parent", "issuelink"),
    field("assignee", "user"),
    field("fixVersions", "array", {
      allowedValues: [
        { id: "20001", name: "Release 1" },
        { id: "20002", name: "Release 2" },
      ],
    }),
    field("customfield_10016", "number", { customId: 10016 }),
  ]
}

function metadataResponse(
  request: CapturedRequest,
  options: {
    users?: unknown[]
    issueTypes?: Array<{
      id: string
      name: string
      subtask: boolean
      hierarchyLevel: number
    }>
    hierarchyIssueTypes?: unknown[]
    linkType?: {
      id: string
      name: string
      outward: string
      inward: string
    }
  } = {}
): Response | null {
  const path = request.url.pathname
  const issueTypes = options.issueTypes ?? [
    { id: "10010", name: "Epic", subtask: false, hierarchyLevel: 1 },
    { id: "10011", name: "Story", subtask: false, hierarchyLevel: 0 },
    { id: "10012", name: "Task", subtask: false, hierarchyLevel: 0 },
  ]
  if (path === "/rest/api/3/serverInfo") {
    return json({ baseUrl: SITE_URL })
  }
  if (path === "/rest/api/3/project/100") {
    return json({ id: "100", key: "ENG", name: "Engineering" })
  }
  if (path === "/rest/api/3/issue/createmeta/100/issuetypes") {
    return json({
      startAt: 0,
      total: issueTypes.length,
      issueTypes: issueTypes.map(({ hierarchyLevel: _level, ...item }) => item),
    })
  }
  if (path === "/rest/api/3/issuetype") {
    return json(options.hierarchyIssueTypes ?? issueTypes)
  }
  const hierarchy = /^\/rest\/api\/3\/issuetype\/(\d+)$/.exec(path)
  if (hierarchy) {
    const issueType = issueTypes.find((item) => item.id === hierarchy[1])
    return issueType ? json({ hierarchyLevel: issueType.hierarchyLevel }) : null
  }
  const fields =
    /^\/rest\/api\/3\/issue\/createmeta\/100\/issuetypes\/(1001[012])$/.exec(
      path
    )
  if (fields) {
    const values = createFields()
    return json({ startAt: 0, total: values.length, fields: values })
  }
  if (path === "/rest/api/3/issueLinkType") {
    return json({
      issueLinkTypes: [
        options.linkType ?? {
          id: "10000",
          name: "Blocks",
          outward: "blocks",
          inward: "is blocked by",
        },
      ],
    })
  }
  if (path === "/rest/api/3/user/assignable/search") {
    return json(
      options.users ?? [
        {
          accountId: "ada-account",
          displayName: "Ada Lovelace",
          emailAddress: "ada@example.com",
          active: true,
        },
      ]
    )
  }
  return null
}

function preparedPlan(): PreparedPlan {
  const data: PreparedPlanData = {
    source,
    project: {
      id: "100",
      key: "ENG",
      name: "Engineering",
      url: `${SITE_URL}/browse/ENG`,
    },
    blocksLinkType: {
      id: "10000",
      name: "Blocks",
      outward: "blocks",
      inward: "is blocked by",
    },
    estimateFieldId: "customfield_10016",
    epic: {
      clientKey: "delivery",
      summary: "Delivery epic",
      description: "Coordinate delivery",
      acceptanceCriteria: "All work ships",
      issueType: { id: "10010", name: "Epic" },
      assignee: null,
      labels: ["plan"],
      estimate: null,
      fixVersion: null,
    },
    children: [
      {
        clientKey: "api",
        summary: "Build API",
        description: "Implement the API",
        acceptanceCriteria: "Contract tests pass",
        issueType: { id: "10011", name: "Story" },
        assignee: { id: "ada-account", name: "Ada Lovelace" },
        labels: ["implementation"],
        estimate: 5,
        fixVersion: { id: "20001", name: "Release 1" },
      },
      {
        clientKey: "ui",
        summary: "Build UI",
        description: "Implement the UI",
        acceptanceCriteria: "Interaction tests pass",
        issueType: { id: "10012", name: "Task" },
        assignee: null,
        labels: ["implementation"],
        estimate: null,
        fixVersion: null,
      },
    ],
    dependencies: [{ blockerClientKey: "api", blockedClientKey: "ui" }],
  }
  return { ...data, planVersion: buildPlanVersion(data) }
}

function marker(plan: PreparedPlan, item: PreparedNode): JiraPlanMarker {
  return {
    version: 1,
    sourcePageId: PAGE_ID,
    sourceLastEditedTime: plan.source.lastEditedTime,
    planVersion: plan.planVersion,
    clientKey: item.clientKey,
    expectedClientKeys: preparedNodes(plan).map(
      (candidate) => candidate.clientKey
    ),
    dependencies: [...plan.dependencies],
  }
}

function descriptionDocument(plan: PreparedPlan, item: PreparedNode): unknown {
  const content: unknown[] = []
  for (const line of item.description.split("\n")) {
    if (item.description === "" && line === "") break
    content.push({
      type: "paragraph",
      content: line === "" ? [] : [{ type: "text", text: line }],
    })
  }
  if (item.acceptanceCriteria !== "") {
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
    for (const line of item.acceptanceCriteria.split("\n")) {
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

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, item]) => [key, reverseObjectKeys(item)])
  )
}

function issueFor(
  plan: PreparedPlan,
  item: PreparedNode,
  id: string,
  key: string,
  parent: { id: string; key: string } | null
): Record<string, unknown> {
  return {
    id,
    key,
    fields: {
      project: { id: plan.project.id },
      summary: item.summary,
      description: descriptionDocument(plan, item),
      issuetype: { id: item.issueType.id, name: item.issueType.name },
      parent,
      labels: [...item.labels, pageLabel(plan.source.pageId)],
      assignee: item.assignee ? { accountId: item.assignee.id } : null,
      fixVersions: item.fixVersion ? [{ id: item.fixVersion.id }] : [],
      ...(config.estimateFieldId && item.estimate !== null
        ? { [config.estimateFieldId]: item.estimate }
        : {}),
    },
    properties: {
      [JiraClient.PROPERTY_KEY]: marker(plan, item),
    },
  }
}

test("prepare resolves readable Jira values, performs no mutations, and returns an exact preview", async () => {
  const requests: CapturedRequest[] = []
  const client = new JiraClient(config, {
    fetch: capturedFetch((request) => {
      const metadata = metadataResponse(request)
      if (metadata) return metadata
      if (
        request.url.pathname === "/rest/api/3/search/jql" &&
        request.method === "POST"
      ) {
        return json({ isLast: true, issues: [] })
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`)
    }, requests),
  })

  const result = await client.prepare(draftPlan(), source)

  assert.equal(result.status, "ready")
  assert.equal(result.ok, true)
  assert(result.preparedPlan)
  assert.deepEqual(
    preparedNodes(result.preparedPlan).map((item) => [
      item.clientKey,
      item.issueType,
      item.assignee,
      item.fixVersion,
    ]),
    [
      ["delivery", { id: "10010", name: "Epic" }, null, null],
      [
        "api",
        { id: "10011", name: "Story" },
        { id: "ada-account", name: "Ada Lovelace" },
        { id: "20001", name: "Release 1" },
      ],
      ["ui", { id: "10012", name: "Task" }, null, null],
    ]
  )
  assert.match(result.preparedPlan.planVersion, /^sha256:[a-f0-9]{64}$/)
  assert(
    result.warnings.some((warning) =>
      /notifications and automation/i.test(warning)
    )
  )

  const search = requests.find(
    (request) => request.url.pathname === "/rest/api/3/search/jql"
  )
  assert(search)
  assert.equal(
    (search.body as { jql: string }).jql,
    `project = "ENG" AND labels = "${pageLabel(PAGE_ID)}" ORDER BY id ASC`
  )
  assert.equal(
    requests.filter(
      (request) =>
        request.method !== "GET" &&
        request.url.pathname !== "/rest/api/3/search/jql"
    ).length,
    0
  )
  assert(
    requests.every((request) => request.url.hostname === "api.atlassian.com")
  )
  assert(
    requests.some((request) => request.url.pathname === "/rest/api/3/issuetype")
  )
  assert(
    requests.every(
      (request) => request.url.pathname !== "/rest/api/3/issuetype/project"
    )
  )
})

test("prepare returns bounded choices instead of guessing ambiguous names", async () => {
  const requests: CapturedRequest[] = []
  const users = Array.from({ length: 6 }, (_, index) => ({
    accountId: `sam-${index}`,
    displayName: `Sam ${index}`,
    emailAddress: `sam-${index}@example.com`,
    active: true,
  }))
  const client = new JiraClient(config, {
    fetch: capturedFetch((request) => {
      const metadata = metadataResponse(request, { users })
      if (metadata) return metadata
      if (
        request.url.pathname === "/rest/api/3/search/jql" &&
        request.method === "POST"
      ) {
        return json({ isLast: true, issues: [] })
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`)
    }, requests),
  })
  const input = draftPlan({
    epic: node("delivery", "Epic", { assigneeName: "Sam" }),
    children: [node("ui", "Task"), node("api", "Stor")],
  })

  const result = await client.prepare(input, source)

  assert.equal(result.status, "needs_choice")
  assert.equal(result.preparedPlan, null)
  assert.deepEqual(
    result.choices.map((item) => item.field),
    ["children[1].issueTypeId", "epic.assigneeAccountId"]
  )
  const people = result.choices[1]
  assert.equal(people.candidates.length, 5)
  assert.equal(people.hasMore, true)
  assert(
    people.candidates.every((candidate) => candidate.label.startsWith("Sam "))
  )
  assert.equal(
    requests.some((request) => request.url.pathname === "/rest/api/3/issue"),
    false
  )

  const selected = draftPlan({
    epic: node("delivery", "Epic", {
      assigneeName: "Sam 4",
      assigneeAccountId: "sam-4",
    }),
    children: [
      node("ui", "Task"),
      node("api", "Stor", { issueTypeId: "10011" }),
    ],
  })
  const resolved = await client.prepare(selected, source)

  assert.equal(resolved.status, "ready")
  assert.equal(resolved.preparedPlan?.epic.assignee?.id, "sam-4")
  assert.equal(
    resolved.preparedPlan?.children.find((item) => item.clientKey === "api")
      ?.issueType.name,
    "Story"
  )
})

test("prepare offers only issue types valid for each hierarchy role", async () => {
  const issueTypes = [
    { id: "10010", name: "Epic", subtask: false, hierarchyLevel: 1 },
    { id: "10013", name: "Feature", subtask: false, hierarchyLevel: 1 },
    { id: "10011", name: "Story", subtask: false, hierarchyLevel: 0 },
    { id: "10012", name: "Task", subtask: false, hierarchyLevel: 0 },
    { id: "10014", name: "Initiative", subtask: false, hierarchyLevel: 2 },
    { id: "10015", name: "Subtask", subtask: true, hierarchyLevel: -1 },
  ]
  const client = new JiraClient(config, {
    fetch: capturedFetch((request) => {
      const metadata = metadataResponse(request, { issueTypes })
      if (metadata) return metadata
      throw new Error(`Unexpected request: ${request.method} ${request.url}`)
    }),
  })
  const input = draftPlan({
    epic: node("delivery", "Unknown epic"),
    children: [node("api", "Unknown child")],
    dependencies: [],
  })

  const result = await client.prepare(input, source)

  assert.equal(result.status, "needs_choice")
  assert.deepEqual(
    result.choices.map((item) => [
      item.field,
      item.candidates.map((candidate) => candidate.id),
    ]),
    [
      ["epic.issueTypeId", ["10010", "10013"]],
      ["children[0].issueTypeId", ["10011", "10012"]],
    ]
  )
})

test("prepare rejects a selected issue type from the wrong hierarchy with valid choices", async () => {
  const client = new JiraClient(config, {
    fetch: capturedFetch((request) => {
      const metadata = metadataResponse(request)
      if (metadata) return metadata
      throw new Error(`Unexpected request: ${request.method} ${request.url}`)
    }),
  })
  const input = draftPlan({
    epic: node("delivery", "Story", { issueTypeId: "10011" }),
  })

  const result = await client.prepare(input, source)

  assert.equal(result.status, "needs_choice")
  assert.deepEqual(result.choices[0], {
    field: "epic.issueTypeId",
    query: "Story",
    candidates: [
      {
        id: "10010",
        label: "Epic",
        detail: "Creatable epic-level Jira issue type",
      },
    ],
    hasMore: false,
  })
})

test("prepare fails closed when hierarchy metadata omits a creatable type", async () => {
  const client = new JiraClient(config, {
    fetch: capturedFetch((request) => {
      const metadata = metadataResponse(request, {
        hierarchyIssueTypes: [
          { id: "10010", name: "Epic", subtask: false, hierarchyLevel: 1 },
          { id: "10011", name: "Story", subtask: false, hierarchyLevel: 0 },
        ],
      })
      if (metadata) return metadata
      throw new Error(`Unexpected request: ${request.method} ${request.url}`)
    }),
  })

  await assert.rejects(
    () => client.prepare(draftPlan(), source),
    /hierarchy metadata was incomplete/i
  )
})

test("prepare requires an explicit assignee choice even for one name match", async () => {
  const client = new JiraClient(config, {
    fetch: capturedFetch((request) => {
      const metadata = metadataResponse(request)
      if (metadata) return metadata
      throw new Error(`Unexpected request: ${request.method} ${request.url}`)
    }),
  })
  const input = draftPlan({
    children: [
      node("api", "Story", { assigneeName: "Ada Lovelace" }),
      node("ui", "Task"),
    ],
  })

  const result = await client.prepare(input, source)

  assert.equal(result.status, "needs_choice")
  assert.deepEqual(result.choices, [
    {
      field: "children[0].assigneeAccountId",
      query: "Ada Lovelace",
      candidates: [
        {
          id: "ada-account",
          label: "Ada Lovelace",
          detail: "ada@example.com",
        },
      ],
      hasMore: true,
    },
  ])
})

function publicationHarness(
  plan: PreparedPlan,
  options: {
    failFirstCreate?: boolean
    ambiguousCreateAt?: number
    firstCreateStatus?: number
    rejectCreateAt?: number
    failIssueReadbackAt?: number
    mismatchIssueReadbackAt?: number
    reorderIssueReadbackAt?: number
    failDependencyRead?: boolean
    failDependencyReadsAfter?: number
    oversizedFirstCreateResponse?: boolean
    changedLinkSemantics?: boolean
    changedHierarchy?: boolean
    elapsedBeforeCreatesMs?: number
    existingEpic?: boolean
    existingCompleteIssues?: boolean
  } = {}
): {
  client: JiraClient
  requests: CapturedRequest[]
  issueBodies: Array<Record<string, unknown>>
  linkBodies: Array<Record<string, unknown>>
} {
  const requests: CapturedRequest[] = []
  const issueBodies: Array<Record<string, unknown>> = []
  const linkBodies: Array<Record<string, unknown>> = []
  const issues = new Map<string, Record<string, unknown>>()
  const links: Array<{ blockerId: string; blockedId: string }> = []
  const createdIndexById = new Map<string, number>()
  let nextId = 500
  let dependencyReads = 0
  let now = 0

  if (options.existingEpic || options.existingCompleteIssues) {
    issues.set("400", issueFor(plan, plan.epic, "400", "ENG-400", null))
  }
  if (options.existingCompleteIssues) {
    plan.children.forEach((item, index) => {
      const id = String(401 + index)
      issues.set(
        id,
        issueFor(plan, item, id, `ENG-${id}`, {
          id: "400",
          key: "ENG-400",
        })
      )
    })
  }

  const fetch = capturedFetch((request) => {
    const metadata = metadataResponse(
      request,
      options.changedLinkSemantics
        ? {
            linkType: {
              id: "10000",
              name: "Blocks",
              outward: "is blocked by",
              inward: "blocks",
            },
          }
        : options.changedHierarchy
          ? {
              issueTypes: [
                {
                  id: "10010",
                  name: "Epic",
                  subtask: false,
                  hierarchyLevel: 0,
                },
                {
                  id: "10011",
                  name: "Story",
                  subtask: false,
                  hierarchyLevel: 0,
                },
                {
                  id: "10012",
                  name: "Task",
                  subtask: false,
                  hierarchyLevel: 0,
                },
              ],
            }
          : {}
    )
    if (metadata) return metadata
    const path = request.url.pathname
    if (path === "/rest/api/3/search/jql" && request.method === "POST") {
      if (options.elapsedBeforeCreatesMs !== undefined) {
        now = options.elapsedBeforeCreatesMs
      }
      return json({
        isLast: true,
        issues: [...issues.values()].map((item) => ({
          id: item.id,
          key: item.key,
        })),
      })
    }
    if (path === "/rest/api/3/issue" && request.method === "POST") {
      const body = request.body as Record<string, unknown>
      issueBodies.push(body)
      if (
        (options.failFirstCreate && issueBodies.length === 1) ||
        options.ambiguousCreateAt === issueBodies.length
      ) {
        return json(
          { errorMessages: ["provider detail must not escape"] },
          503,
          { "x-arequestid": "ambiguous-create" }
        )
      }
      if (options.firstCreateStatus && issueBodies.length === 1) {
        return json({}, options.firstCreateStatus, {
          "x-arequestid": "unusual-create",
        })
      }
      if (options.rejectCreateAt === issueBodies.length) {
        return json({ errors: { summary: "rejected" } }, 400, {
          "x-arequestid": "rejected-create",
        })
      }
      const fields = body.fields as Record<string, unknown>
      const id = String(nextId)
      const key = `ENG-${nextId}`
      nextId += 1
      const issueTypeId = (fields.issuetype as { id: string }).id
      const item = preparedNodes(plan).find(
        (candidate) =>
          candidate.issueType.id === issueTypeId &&
          candidate.summary === fields.summary
      ) as PreparedNode
      const parentId = (fields.parent as { id?: string } | undefined)?.id
      const parentIssue = parentId ? issues.get(parentId) : null
      const properties = Object.fromEntries(
        (body.properties as Array<{ key: string; value: unknown }>).map(
          (property) => [property.key, property.value]
        )
      )
      issues.set(id, {
        id,
        key,
        fields: {
          ...fields,
          project: { id: plan.project.id },
          issuetype: { id: item.issueType.id, name: item.issueType.name },
          parent: parentIssue
            ? { id: parentId, key: parentIssue.key as string }
            : null,
          assignee: fields.assignee
            ? {
                accountId: (fields.assignee as { accountId: string }).accountId,
              }
            : null,
          fixVersions: fields.fixVersions ?? [],
        },
        properties,
      })
      createdIndexById.set(id, issueBodies.length)
      if (options.oversizedFirstCreateResponse && issueBodies.length === 1) {
        return new Response("x".repeat(1_000_001), {
          status: 201,
          headers: { "x-arequestid": "oversized-create" },
        })
      }
      return json({ id, key }, 201, { "x-arequestid": `create-${id}` })
    }
    const issueMatch = /^\/rest\/api\/3\/issue\/(\d+)$/.exec(path)
    if (issueMatch && request.method === "GET") {
      const id = issueMatch[1]
      if (request.url.searchParams.get("fields") === "issuelinks") {
        dependencyReads += 1
        if (
          (options.failDependencyRead && linkBodies.length === 0) ||
          (options.failDependencyReadsAfter !== undefined &&
            dependencyReads >= options.failDependencyReadsAfter)
        ) {
          return json({}, 503)
        }
        return json({
          fields: {
            issuelinks: links
              .filter((link) => link.blockerId === id)
              .map((link) => ({
                type: { id: config.blocksLinkTypeId, name: "Blocks" },
                outwardIssue: { id: link.blockedId },
              })),
          },
        })
      }
      const issue = issues.get(id)
      if (!issue) return json({}, 404)
      const createdIndex = createdIndexById.get(id)
      if (
        options.failIssueReadbackAt !== undefined &&
        options.failIssueReadbackAt === createdIndex
      ) {
        return json({}, 503, { "retry-after": "0" })
      }
      const observedIssue =
        options.mismatchIssueReadbackAt !== undefined &&
        options.mismatchIssueReadbackAt === createdIndex
          ? {
              ...issue,
              fields: {
                ...(issue.fields as Record<string, unknown>),
                description: { version: 1, type: "doc", content: [] },
              },
            }
          : issue
      return json(
        options.reorderIssueReadbackAt !== undefined &&
          options.reorderIssueReadbackAt === createdIndex
          ? reverseObjectKeys(observedIssue)
          : observedIssue
      )
    }
    if (path === "/rest/api/3/issueLink" && request.method === "POST") {
      const body = request.body as Record<string, unknown>
      linkBodies.push(body)
      links.push({
        blockerId: (body.outwardIssue as { id: string }).id,
        blockedId: (body.inwardIssue as { id: string }).id,
      })
      return new Response(null, {
        status: 201,
        headers: { "x-arequestid": "link-1" },
      })
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`)
  }, requests)

  return {
    client: new JiraClient(config, { fetch, now: () => now }),
    requests,
    issueBodies,
    linkBodies,
  }
}

test("publish writes the epic first, preserves the exact marker and backlink, then creates the directed dependency", async () => {
  const plan = preparedPlan()
  const harness = publicationHarness(plan)

  const result = await harness.client.publish(plan, source)

  assert.equal(result.status, "completed")
  assert.equal(result.changed, true)
  assert.deepEqual(
    result.issues.map((item) => [item.clientKey, item.state, item.key]),
    [
      ["delivery", "created", "ENG-500"],
      ["api", "created", "ENG-501"],
      ["ui", "created", "ENG-502"],
    ]
  )
  assert.deepEqual(
    harness.issueBodies.map(
      (body) => (body.fields as { summary: string }).summary
    ),
    ["Delivery epic", "Build API", "Build UI"]
  )
  assert.equal(
    (harness.issueBodies[0].fields as { parent?: unknown }).parent,
    undefined
  )
  assert.deepEqual(
    (harness.issueBodies[1].fields as { parent: unknown }).parent,
    { id: "500" }
  )
  assert.deepEqual(
    (harness.issueBodies[2].fields as { parent: unknown }).parent,
    { id: "500" }
  )
  assert.deepEqual(
    (harness.issueBodies[1].fields as { assignee: unknown }).assignee,
    { accountId: "ada-account" }
  )
  assert.deepEqual(
    (harness.issueBodies[1].fields as { fixVersions: unknown }).fixVersions,
    [{ id: "20001" }]
  )
  assert.equal(
    (harness.issueBodies[1].fields as Record<string, unknown>)[
      "customfield_10016"
    ],
    5
  )

  for (const [index, body] of harness.issueBodies.entries()) {
    const item = preparedNodes(plan)[index]
    const properties = body.properties as Array<{
      key: string
      value: unknown
    }>
    assert.deepEqual(properties, [
      { key: JiraClient.PROPERTY_KEY, value: marker(plan, item) },
    ])
    const fields = body.fields as {
      labels: string[]
      description: { content: unknown[] }
    }
    assert(fields.labels.includes(pageLabel(plan.source.pageId)))
    assert.deepEqual(fields.description, descriptionDocument(plan, item))
  }

  assert.deepEqual(harness.linkBodies, [
    {
      type: { id: "10000" },
      outwardIssue: { id: "501" },
      inwardIssue: { id: "502" },
    },
  ])
  assert.equal(result.dependencies[0].state, "created")
})

function inspectionFetch(
  plan: PreparedPlan,
  options: {
    tamperClientKey?: string
    tamperSummaryClientKey?: string
    oversizedMarker?: boolean
    detachedClientKey?: string
  } = {}
): typeof fetch {
  const ordered = preparedNodes(plan)
  const ids = ["700", "701", "702"]
  const keys = ["ENG-700", "ENG-701", "ENG-702"]
  const issues = new Map(
    ordered.map((item, index) => {
      const parent = index === 0 ? null : { id: ids[0], key: keys[0] }
      const issue = issueFor(plan, item, ids[index], keys[index], parent)
      if (item.clientKey === options.tamperClientKey) {
        ;(
          (issue.properties as Record<string, unknown>)[
            JiraClient.PROPERTY_KEY
          ] as JiraPlanMarker
        ).sourcePageId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
      if (item.clientKey === options.tamperSummaryClientKey) {
        ;(issue.fields as Record<string, unknown>).summary = "Manually edited"
      }
      if (item.clientKey === options.detachedClientKey) {
        ;(issue.fields as Record<string, unknown>).parent = {
          id: "999",
          key: "ENG-999",
        }
      }
      if (item.clientKey === "delivery" && options.oversizedMarker) {
        ;(
          (issue.properties as Record<string, unknown>)[
            JiraClient.PROPERTY_KEY
          ] as JiraPlanMarker
        ).dependencies = Array.from({ length: 11 }, (_, index) => ({
          blockerClientKey: "api",
          blockedClientKey: index % 2 === 0 ? "ui" : "api",
        }))
      }
      return [ids[index], issue] as const
    })
  )
  return capturedFetch((request) => {
    const metadata = metadataResponse(request)
    if (metadata) return metadata
    const path = request.url.pathname
    if (path === "/rest/api/3/search/jql" && request.method === "POST") {
      return json({
        isLast: true,
        issues: ids.map((id, index) => ({ id, key: keys[index] })),
      })
    }
    const match = /^\/rest\/api\/3\/issue\/(\d+)$/.exec(path)
    if (match && request.method === "GET") {
      if (request.url.searchParams.get("fields") === "issuelinks") {
        return json({
          fields: {
            issuelinks:
              match[1] === "701"
                ? [
                    {
                      type: { id: "10000", name: "Blocks" },
                      outwardIssue: { id: "702" },
                    },
                  ]
                : [],
          },
        })
      }
      return json(issues.get(match[1]) ?? {})
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`)
  })
}

test("inspect trusts only a matching source label plus exact issue properties", async (t) => {
  const plan = preparedPlan()

  await t.test("reports a complete verified plan", async () => {
    const client = new JiraClient(config, { fetch: inspectionFetch(plan) })
    const result = await client.inspect(PAGE_ID)

    assert.equal(result.status, "complete")
    assert.equal(result.ok, true)
    assert.equal(result.planVersion, plan.planVersion)
    assert.deepEqual(result.missingClientKeys, [])
    assert.deepEqual(result.dependencies, [
      {
        blockerClientKey: "api",
        blockedClientKey: "ui",
        state: "existing",
      },
    ])
  })

  await t.test(
    "fails closed when a labeled issue has a forged marker",
    async () => {
      const client = new JiraClient(config, {
        fetch: inspectionFetch(plan, { tamperClientKey: "ui" }),
      })
      const result = await client.inspect(PAGE_ID)

      assert.equal(result.status, "conflict")
      assert.equal(result.ok, false)
      assert(result.missingClientKeys.includes("ui"))
      assert.equal(result.nextAction, "manual_review")
    }
  )

  await t.test("rejects an oversized untrusted issue property", async () => {
    const client = new JiraClient(config, {
      fetch: inspectionFetch(plan, { oversizedMarker: true }),
    })
    const result = await client.inspect(PAGE_ID)

    assert.equal(result.status, "conflict")
    assert.equal(result.nextAction, "manual_review")
  })

  await t.test("rejects a marked child under the wrong epic", async () => {
    const client = new JiraClient(config, {
      fetch: inspectionFetch(plan, { detachedClientKey: "ui" }),
    })
    const result = await client.inspect(PAGE_ID)

    assert.equal(result.status, "conflict")
    assert.equal(result.nextAction, "manual_review")
  })

  await t.test(
    "returns the recorded source without rereading Notion",
    async () => {
      const client = new JiraClient(config, { fetch: inspectionFetch(plan) })
      const result = await client.inspect(PAGE_ID)

      assert.equal(result.status, "complete")
      assert.deepEqual(result.source, source)
    }
  )
})

test("prepare does not call manually drifted marked work an exact publication", async () => {
  const plan = preparedPlan()
  const input: DraftPlan = {
    sourcePageId: PAGE_ID,
    epic: {
      clientKey: plan.epic.clientKey,
      summary: plan.epic.summary,
      description: plan.epic.description,
      acceptanceCriteria: plan.epic.acceptanceCriteria,
      issueTypeName: plan.epic.issueType.name,
      issueTypeId: null,
      assigneeName: null,
      assigneeAccountId: null,
      labels: plan.epic.labels,
      estimate: null,
      fixVersionName: null,
      fixVersionId: null,
    },
    children: plan.children.map((item) => ({
      clientKey: item.clientKey,
      summary: item.summary,
      description: item.description,
      acceptanceCriteria: item.acceptanceCriteria,
      issueTypeName: item.issueType.name,
      issueTypeId: item.issueType.id,
      assigneeName: item.assignee?.name ?? null,
      assigneeAccountId: item.assignee?.id ?? null,
      labels: item.labels,
      estimate: item.estimate,
      fixVersionName: item.fixVersion?.name ?? null,
      fixVersionId: item.fixVersion?.id ?? null,
    })),
    dependencies: plan.dependencies,
  }
  const client = new JiraClient(config, {
    fetch: inspectionFetch(plan, { tamperSummaryClientKey: "api" }),
  })

  const result = await client.prepare(input, source)

  assert.equal(result.status, "conflict")
  assert.equal(result.preparedPlan, null)
  assert.match(result.message, /no longer matches/i)
})

test("publish rejects a stale prepared page before contacting Jira", async () => {
  let calls = 0
  const client = new JiraClient(config, {
    fetch: capturedFetch(() => {
      calls += 1
      throw new Error("Jira must not be called for a stale page")
    }),
  })
  const plan = preparedPlan()

  const result = await client.publish(plan, {
    ...source,
    lastEditedTime: "2026-07-05T12:05:00.000Z",
  })

  assert.equal(result.status, "conflict")
  assert.equal(result.changed, false)
  assert.equal(result.nextAction, "prepare_again")
  assert.equal(calls, 0)
})

test("publish rejects non-canonical prepared values before contacting Jira", async () => {
  let calls = 0
  const client = new JiraClient(config, {
    fetch: capturedFetch(() => {
      calls += 1
      throw new Error("Jira must not be called for a non-canonical plan")
    }),
  })
  const padded = structuredClone(preparedPlan())
  padded.epic.summary = `${" ".repeat(1_000)}${padded.epic.summary}`
  padded.planVersion = buildPlanVersion(padded)
  const unnormalizedDependency = structuredClone(preparedPlan())
  unnormalizedDependency.dependencies = [
    { blockerClientKey: " API ", blockedClientKey: "ui" },
  ]
  unnormalizedDependency.planVersion = buildPlanVersion(unnormalizedDependency)

  await assert.rejects(
    () => client.publish(padded, source),
    /surrounding whitespace/i
  )
  await assert.rejects(
    () => client.publish(unnormalizedDependency, source),
    /dependencies must be normalized/i
  )
  assert.equal(calls, 0)
})

test("publish rejects an estimate-field configuration change before Jira", async () => {
  let calls = 0
  const client = new JiraClient(
    { ...config, estimateFieldId: "customfield_10017" },
    {
      fetch: capturedFetch(() => {
        calls += 1
        throw new Error("Jira must not be called after estimate-field drift")
      }),
    }
  )

  const result = await client.publish(preparedPlan(), source)

  assert.equal(result.status, "conflict")
  assert.equal(result.changed, false)
  assert.equal(result.nextAction, "prepare_again")
  assert.equal(calls, 0)
})

test("publish stops before writes when confirmed link semantics change", async () => {
  const plan = preparedPlan()
  const harness = publicationHarness(plan, { changedLinkSemantics: true })

  await assert.rejects(
    () => harness.client.publish(plan, source),
    /blocks link semantics changed/i
  )

  assert.equal(harness.issueBodies.length, 0)
  assert.equal(harness.linkBodies.length, 0)
})

test("publish stops before writes when a confirmed issue hierarchy changes", async () => {
  const plan = preparedPlan()
  const harness = publicationHarness(plan, { changedHierarchy: true })

  await assert.rejects(
    () => harness.client.publish(plan, source),
    /Jira hierarchy changed/i
  )

  assert.equal(harness.issueBodies.length, 0)
  assert.equal(harness.linkBodies.length, 0)
})

test("an ambiguous create is attempted once and stops every later write", async () => {
  const plan = preparedPlan()
  const harness = publicationHarness(plan, { failFirstCreate: true })

  const result = await harness.client.publish(plan, source)

  assert.equal(result.status, "ambiguous")
  assert.equal(result.changed, null)
  assert.equal(result.requestId, "ambiguous-create")
  assert.deepEqual(
    result.issues.map((item) => [item.clientKey, item.state]),
    [
      ["delivery", "unknown"],
      ["api", "not_attempted"],
      ["ui", "not_attempted"],
    ]
  )
  assert.equal(harness.issueBodies.length, 1)
  assert.equal(harness.linkBodies.length, 0)
  assert.doesNotMatch(result.message, /provider detail/)
})

test("publish does not start a mutation without enough budget for readback", async () => {
  const plan = preparedPlan()
  const harness = publicationHarness(plan, { elapsedBeforeCreatesMs: 40_000 })

  const result = await harness.client.publish(plan, source)

  assert.equal(result.status, "blocked")
  assert.equal(result.changed, false)
  assert.equal(result.nextAction, "inspect_again")
  assert.equal(result.issues[0].state, "not_attempted")
  assert.equal(harness.issueBodies.length, 0)
  assert.equal(harness.linkBodies.length, 0)
})

test("an acknowledged create keeps its identity when exact readback is unavailable", async () => {
  const plan = preparedPlan()
  const harness = publicationHarness(plan, { failIssueReadbackAt: 1 })

  const result = await harness.client.publish(plan, source)

  assert.equal(result.status, "partial")
  assert.equal(result.changed, true)
  assert.equal(result.nextAction, "manual_review")
  assert.equal(result.requestId, "create-500")
  assert.deepEqual(
    result.issues.map((item) => [
      item.clientKey,
      item.state,
      item.id,
      item.key,
    ]),
    [
      ["delivery", "created", "500", "ENG-500"],
      ["api", "not_attempted", null, null],
      ["ui", "not_attempted", null, null],
    ]
  )
  assert.equal(harness.issueBodies.length, 1)
  assert.equal(harness.linkBodies.length, 0)
})

test("an acknowledged create keeps its identity after an exact readback mismatch", async () => {
  const plan = preparedPlan()
  const harness = publicationHarness(plan, { mismatchIssueReadbackAt: 1 })

  const result = await harness.client.publish(plan, source)

  assert.equal(result.status, "partial")
  assert.equal(result.changed, true)
  assert.equal(result.nextAction, "manual_review")
  assert.deepEqual(result.issues[0], {
    clientKey: "delivery",
    state: "created",
    id: "500",
    key: "ENG-500",
    url: `${SITE_URL}/browse/ENG-500`,
  })
  assert.equal(harness.issueBodies.length, 1)
  assert.equal(harness.linkBodies.length, 0)
})

test("a later ambiguous create preserves an earlier confirmed change", async () => {
  const plan = preparedPlan()
  const harness = publicationHarness(plan, { ambiguousCreateAt: 2 })

  const result = await harness.client.publish(plan, source)

  assert.equal(result.status, "ambiguous")
  assert.equal(result.changed, true)
  assert.deepEqual(
    result.issues.map((item) => [item.clientKey, item.state]),
    [
      ["delivery", "created"],
      ["api", "unknown"],
      ["ui", "not_attempted"],
    ]
  )
  assert.equal(harness.issueBodies.length, 2)
  assert.equal(harness.linkBodies.length, 0)
})

test("exact readback ignores JSON object key order in Jira descriptions", async () => {
  const plan = preparedPlan()
  const harness = publicationHarness(plan, { reorderIssueReadbackAt: 1 })

  const result = await harness.client.publish(plan, source)

  assert.equal(result.status, "completed")
  assert.equal(result.changed, true)
  assert(result.issues.every((item) => item.state === "created"))
})

test("an undocumented create 404 remains outcome-unknown", async () => {
  const plan = preparedPlan()
  const harness = publicationHarness(plan, { firstCreateStatus: 404 })

  const result = await harness.client.publish(plan, source)

  assert.equal(result.status, "ambiguous")
  assert.equal(result.changed, null)
  assert.equal(harness.issueBodies.length, 1)
})

test("an oversized successful create response remains outcome-unknown", async () => {
  const plan = preparedPlan()
  const harness = publicationHarness(plan, {
    oversizedFirstCreateResponse: true,
  })

  const result = await harness.client.publish(plan, source)

  assert.equal(result.status, "ambiguous")
  assert.equal(result.changed, true)
  assert.equal(result.requestId, "oversized-create")
  assert.equal(result.issues[0].state, "unknown")
  assert.equal(harness.issueBodies.length, 1)
})

test("a definite child rejection reports a partial result and stops later writes", async () => {
  const plan = preparedPlan()
  const harness = publicationHarness(plan, { rejectCreateAt: 2 })

  const result = await harness.client.publish(plan, source)

  assert.equal(result.status, "partial")
  assert.equal(result.changed, true)
  assert.deepEqual(
    result.issues.map((item) => [item.clientKey, item.state]),
    [
      ["delivery", "created"],
      ["api", "rejected"],
      ["ui", "not_attempted"],
    ]
  )
  assert.equal(harness.issueBodies.length, 2)
  assert.equal(harness.linkBodies.length, 0)
})

test("a replay with an existing epic remains partial after a definite child rejection", async () => {
  const plan = preparedPlan()
  const harness = publicationHarness(plan, {
    existingEpic: true,
    rejectCreateAt: 1,
  })

  const result = await harness.client.publish(plan, source)

  assert.equal(result.status, "partial")
  assert.equal(result.changed, false)
  assert.deepEqual(
    result.issues.map((item) => [item.clientKey, item.state]),
    [
      ["delivery", "existing"],
      ["api", "rejected"],
      ["ui", "not_attempted"],
    ]
  )
  assert.equal(harness.issueBodies.length, 1)
})

test("a dependency pre-read failure preserves already-created issue outcomes", async () => {
  const plan = preparedPlan()
  const harness = publicationHarness(plan, { failDependencyRead: true })

  const result = await harness.client.publish(plan, source)

  assert.equal(result.status, "partial")
  assert.equal(result.changed, true)
  assert(result.issues.every((item) => item.state === "created"))
  assert.equal(result.dependencies[0].state, "not_attempted")
  assert.equal(harness.issueBodies.length, 3)
  assert.equal(harness.linkBodies.length, 0)
})

test("an unverified dependency remains outcome-unknown after a successful response", async () => {
  const plan = preparedPlan()
  const harness = publicationHarness(plan, {
    failDependencyReadsAfter: 2,
  })

  const result = await harness.client.publish(plan, source)

  assert.equal(result.status, "ambiguous")
  assert.equal(result.changed, true)
  assert.equal(result.nextAction, "inspect_again")
  assert.equal(result.requestId, "link-1")
  assert(result.issues.every((item) => item.state === "created"))
  assert.equal(result.dependencies[0].state, "unknown")
  assert.equal(harness.linkBodies.length, 1)
})

test("an unverified dependency does not claim a change when all issues already existed", async () => {
  const plan = preparedPlan()
  const harness = publicationHarness(plan, {
    existingCompleteIssues: true,
    failDependencyReadsAfter: 3,
  })

  const result = await harness.client.publish(plan, source)

  assert.equal(result.status, "ambiguous")
  assert.equal(result.changed, null)
  assert(result.issues.every((item) => item.state === "existing"))
  assert.equal(result.dependencies[0].state, "unknown")
  assert.equal(harness.issueBodies.length, 0)
  assert.equal(harness.linkBodies.length, 1)
})

test("a replay with existing issues remains partial when dependency inspection fails", async () => {
  const plan = preparedPlan()
  const harness = publicationHarness(plan, {
    existingCompleteIssues: true,
    failDependencyReadsAfter: 2,
  })

  const result = await harness.client.publish(plan, source)

  assert.equal(result.status, "partial")
  assert.equal(result.changed, false)
  assert(result.issues.every((item) => item.state === "existing"))
  assert.equal(result.dependencies[0].state, "not_attempted")
  assert.equal(harness.issueBodies.length, 0)
  assert.equal(harness.linkBodies.length, 0)
})

test("publishing an exact existing graph is a no-op", async () => {
  const plan = preparedPlan()
  const requests: Array<{ method: string; pathname: string }> = []
  const baseFetch = inspectionFetch(plan)
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    requests.push({
      method: (init.method ?? "GET").toUpperCase(),
      pathname: url.pathname,
    })
    return baseFetch(input, init)
  }
  const client = new JiraClient(config, { fetch })

  const result = await client.publish(plan, source)

  assert.equal(result.status, "no_op")
  assert.equal(result.changed, false)
  assert(result.issues.every((item) => item.state === "existing"))
  assert.equal(result.dependencies[0].state, "existing")
  assert.equal(
    requests.some(
      (request) =>
        request.method === "POST" &&
        ["/rest/api/3/issue", "/rest/api/3/issueLink"].includes(
          request.pathname
        )
    ),
    false
  )
})

test("read failures retry once while read-only inspection never sends a Jira mutation", async () => {
  const requests: CapturedRequest[] = []
  const sleeps: number[] = []
  let serverInfoAttempts = 0
  const client = new JiraClient(config, {
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    fetch: capturedFetch((request) => {
      if (request.url.pathname === "/rest/api/3/serverInfo") {
        serverInfoAttempts += 1
        if (serverInfoAttempts === 1) {
          return json({}, 503, { "retry-after": "1" })
        }
      }
      const metadata = metadataResponse(request)
      if (metadata) return metadata
      if (
        request.url.pathname === "/rest/api/3/search/jql" &&
        request.method === "POST"
      ) {
        return json({ isLast: true, issues: [] })
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`)
    }, requests),
  })

  const result = await client.inspect(PAGE_ID)

  assert.equal(result.status, "not_observed")
  assert.equal(serverInfoAttempts, 2)
  assert.deepEqual(sleeps, [1_000])
  assert.equal(
    requests.filter(
      (request) =>
        request.method !== "GET" &&
        request.url.pathname !== "/rest/api/3/search/jql"
    ).length,
    0
  )
})

test("read retries do not run before a long Retry-After delay", async () => {
  const sleeps: number[] = []
  let attempts = 0
  const client = new JiraClient(config, {
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    fetch: capturedFetch((request) => {
      if (request.url.pathname === "/rest/api/3/serverInfo") {
        attempts += 1
        return json({}, 429, {
          "retry-after": "10",
          "x-arequestid": "rate-limit-1",
        })
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`)
    }),
  })

  await assert.rejects(
    () => client.inspect(PAGE_ID),
    (error: unknown) =>
      error instanceof JiraError &&
      error.kind === "rate_limited" &&
      error.retryable === true &&
      error.retryAfterSeconds === 10 &&
      error.requestId === "rate-limit-1" &&
      /retry after 10 seconds/i.test(error.message)
  )
  assert.equal(attempts, 1)
  assert.deepEqual(sleeps, [])
})
