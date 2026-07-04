import assert from "node:assert/strict"
import test from "node:test"

import { JiraClient, JiraError } from "../src/jira.js"
import { buildIdentity, nodeMarker } from "../src/policy.js"
import {
  config,
  inputFixture,
  PAGE_ID,
  projectPolicy,
  providerPolicyFingerprint,
} from "./fixtures.js"

function json(
  value: unknown,
  status = 200,
  headers: HeadersInit = {}
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function fields(includeParent: boolean) {
  return [
    "project",
    "issuetype",
    "summary",
    "description",
    "labels",
    "assignee",
    "fixVersions",
    "customfield_10016",
    "customfield_10020",
    ...(includeParent ? ["parent"] : []),
  ].map((fieldId) => {
    const schema =
      fieldId === "customfield_10016"
        ? {
            type: "number",
            custom: "com.atlassian.jira.plugin.system.customfieldtypes:float",
            customId: 10016,
          }
        : fieldId === "customfield_10020"
          ? {
              type: "array",
              items: "json",
              custom: "com.pyxis.greenhopper.jira:gh-sprint",
              customId: 10020,
            }
          : { type: fieldId === "labels" ? "array" : "string" }
    const allowedValues =
      fieldId === "fixVersions"
        ? [{ id: "20001" }]
        : fieldId === "customfield_10020"
          ? [{ id: "30001" }]
          : []
    return {
      fieldId,
      key: fieldId,
      required: ["project", "issuetype", "summary"].includes(fieldId),
      hasDefaultValue: false,
      operations: ["set"],
      allowedValues,
      schema,
    }
  })
}

function siteAndProjectResponses(): Response[] {
  return [
    json({ baseUrl: config.siteUrl }),
    json({ id: projectPolicy.projectId, key: projectPolicy.projectKey }),
  ]
}

function createNodeInput(nodeIndex = 0) {
  const input = inputFixture()
  const identity = buildIdentity(input, providerPolicyFingerprint)
  const node = input.nodes[nodeIndex]
  return {
    operationId: identity.operationId,
    planHash: input.planHash,
    approvalPageId: input.approvalPageId,
    project: projectPolicy,
    node,
    marker: nodeMarker(identity.operationId, node.nodeKey),
    parent:
      node.parentNodeKey === null
        ? null
        : {
            id: String(9000 + nodeIndex),
            key: `ENG-${nodeIndex}`,
            url: `https://example.atlassian.net/browse/ENG-${nodeIndex}`,
          },
  }
}

function expectedDescription(input: ReturnType<typeof createNodeInput>) {
  return {
    version: 1,
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: input.node.description }],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Approved implementation plan in Notion",
            marks: [
              {
                type: "link",
                attrs: { href: `https://www.notion.so/${PAGE_ID}` },
              },
            ],
          },
        ],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: `Publication ${input.operationId}; node ${input.node.nodeKey}`,
          },
        ],
      },
    ],
  }
}

function existingIssue(
  input: ReturnType<typeof createNodeInput>,
  id = "20001",
  key = "ENG-1"
) {
  return {
    id,
    key,
    fields: {
      summary: input.node.summary,
      description: expectedDescription(input),
      issuetype: { id: input.node.issueTypeId },
      parent: input.parent ? { id: input.parent.id } : null,
      labels: [...input.node.labels, input.marker],
      assignee: { accountId: input.node.assigneeAccountId },
      fixVersions: [{ id: input.node.fixVersionId }],
      customfield_10016: input.node.estimatePoints,
      customfield_10020: [{ id: input.node.sprintId }],
    },
    properties: {
      [JiraClient.PROPERTY_KEY]: {
        version: 1,
        operationId: input.operationId,
        planHash: input.planHash,
        sourcePageId: PAGE_ID,
        nodeKey: input.node.nodeKey,
      },
    },
  }
}

test("preflight uses only current paginated project/type field metadata", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const queue = [
    ...siteAndProjectResponses(),
    json({
      issueTypes: [
        { id: "10001", name: "Epic", subtask: false },
        { id: "10002", name: "Story", subtask: false },
        { id: "10003", name: "Subtask", subtask: true },
      ],
      startAt: 0,
      maxResults: 50,
      total: 3,
    }),
    json({ fields: fields(false), startAt: 0, maxResults: 50, total: 9 }),
    json({ fields: fields(true), startAt: 0, maxResults: 50, total: 10 }),
    json({ fields: fields(true), startAt: 0, maxResults: 50, total: 10 }),
    json({ issueLinkTypes: [{ id: "10000", name: "Blocks" }] }),
    json({ accountId: "account-1", active: true }),
    json([{ accountId: "account-1", active: true }]),
  ]
  const client = new JiraClient(config, {
    fetch: async (url, init) => {
      requests.push({ url: String(url), init })
      const next = queue.shift()
      assert(next, "unexpected Jira request")
      return next
    },
  })

  await client.preflight(projectPolicy, inputFixture().nodes)

  assert.equal(queue.length, 0)
  assert.equal(requests.length, 9)
  assert.match(
    requests[2].url,
    /\/rest\/api\/3\/issue\/createmeta\/10000\/issuetypes\?/
  )
  assert(!requests.some(({ url }) => /\/issue\/createmeta(?:\?|$)/.test(url)))
  assert(
    requests.every(({ url }) =>
      url.startsWith("https://api.atlassian.com/ex/jira/")
    )
  )
  assert(
    requests.every(
      ({ init }) =>
        init?.headers && !JSON.stringify(init.headers).includes(config.apiToken)
    )
  )
  const auth = (requests[0].init?.headers as Record<string, string>)
    .Authorization
  assert.equal(
    Buffer.from(auth.slice("Basic ".length), "base64").toString(),
    `${config.email}:${config.apiToken}`
  )
})

test("metadata pagination is complete and bounded", async () => {
  const urls: string[] = []
  const queue = [
    ...siteAndProjectResponses(),
    json({
      issueTypes: [{ id: "10001", name: "Epic", subtask: false }],
      startAt: 0,
      maxResults: 1,
      total: 3,
    }),
    json({
      issueTypes: [
        { id: "10002", name: "Story", subtask: false },
        { id: "10003", name: "Subtask", subtask: true },
      ],
      startAt: 1,
      maxResults: 2,
      total: 3,
    }),
    json({ fields: fields(false), startAt: 0, maxResults: 50, total: 9 }),
    json({ fields: fields(true), startAt: 0, maxResults: 50, total: 10 }),
    json({ fields: fields(true), startAt: 0, maxResults: 50, total: 10 }),
    json({ issueLinkTypes: [{ id: "10000", name: "Blocks" }] }),
    json({ accountId: "account-1", active: true }),
    json([{ accountId: "account-1", active: true }]),
  ]
  const client = new JiraClient(config, {
    fetch: async (url) => {
      urls.push(String(url))
      return queue.shift() as Response
    },
  })
  await client.preflight(projectPolicy, inputFixture().nodes)
  assert.match(urls[3], /startAt=1/)
})

test("missing required tenant field blocks instead of silently dropping it", async () => {
  const metadata = fields(false)
  metadata.push({
    fieldId: "customfield_19999",
    key: "customfield_19999",
    required: true,
    hasDefaultValue: false,
    operations: ["set"],
    allowedValues: [],
    schema: {
      type: "string",
      custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield",
      customId: 19999,
    },
  })
  const queue = [
    ...siteAndProjectResponses(),
    json({
      issueTypes: [
        { id: "10001", name: "Epic", subtask: false },
        { id: "10002", name: "Story", subtask: false },
        { id: "10003", name: "Subtask", subtask: true },
      ],
      startAt: 0,
      maxResults: 50,
      total: 3,
    }),
    json({
      fields: metadata,
      startAt: 0,
      maxResults: 50,
      total: metadata.length,
    }),
  ]
  const client = new JiraClient(config, {
    fetch: async () => queue.shift() as Response,
  })
  await assert.rejects(
    () => client.preflight(projectPolicy, inputFixture().nodes),
    /Required Jira field customfield_19999 is not supplied/
  )
})

test("current metadata rejects an allowlisted version that is no longer selectable", async () => {
  const currentFields = fields(false).map((field) =>
    field.fieldId === "fixVersions"
      ? { ...field, allowedValues: [{ id: "29999" }] }
      : field
  )
  const queue = [
    ...siteAndProjectResponses(),
    json({
      issueTypes: [{ id: "10001", name: "Epic", subtask: false }],
      startAt: 0,
      maxResults: 50,
      total: 1,
    }),
    json({
      fields: currentFields,
      startAt: 0,
      maxResults: 50,
      total: currentFields.length,
    }),
  ]
  const client = new JiraClient(config, {
    fetch: async () => queue.shift() as Response,
  })
  await assert.rejects(
    () => client.preflight(projectPolicy, [inputFixture().nodes[0]]),
    /fix version 20001 is not currently allowed/
  )
})

test("preflight requires affirmative version and sprint selectability", async () => {
  for (const fieldId of ["fixVersions", "customfield_10020"]) {
    const currentFields = fields(false).map((field) =>
      field.fieldId === fieldId ? { ...field, allowedValues: [] } : field
    )
    const queue = [
      ...siteAndProjectResponses(),
      json({
        issueTypes: [{ id: "10001", name: "Epic", subtask: false }],
        startAt: 0,
        maxResults: 50,
        total: 1,
      }),
      json({
        fields: currentFields,
        startAt: 0,
        maxResults: 50,
        total: currentFields.length,
      }),
    ]
    const client = new JiraClient(config, {
      fetch: async () => queue.shift() as Response,
    })
    await assert.rejects(
      () => client.preflight(projectPolicy, [inputFixture().nodes[0]]),
      /did not confirm (fix version|sprint) selectability/
    )
  }
})

test("preflight validates estimate and Sprint custom-field semantics", async () => {
  for (const [fieldId, schema] of [
    [
      "customfield_10016",
      {
        type: "string",
        custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield",
        customId: 10016,
      },
    ],
    [
      "customfield_10020",
      {
        type: "array",
        items: "option",
        custom: "com.atlassian.jira.plugin.system.customfieldtypes:multiselect",
        customId: 10020,
      },
    ],
  ] as const) {
    const currentFields = fields(false).map((field) =>
      field.fieldId === fieldId ? { ...field, schema } : field
    )
    const queue = [
      ...siteAndProjectResponses(),
      json({
        issueTypes: [{ id: "10001", name: "Epic", subtask: false }],
        startAt: 0,
        maxResults: 50,
        total: 1,
      }),
      json({
        fields: currentFields,
        startAt: 0,
        maxResults: 50,
        total: currentFields.length,
      }),
    ]
    const client = new JiraClient(config, {
      fetch: async () => queue.shift() as Response,
    })
    await assert.rejects(
      () => client.preflight(projectPolicy, [inputFixture().nodes[0]]),
      /has incompatible Jira semantics/
    )
  }
})

test("preflight rejects site/project drift and an assignee who is no longer assignable", async () => {
  const wrongSite = new JiraClient(config, {
    fetch: async () => json({ baseUrl: "https://other.atlassian.net" }),
  })
  await assert.rejects(
    () => wrongSite.preflight(projectPolicy, [inputFixture().nodes[0]]),
    /site URL does not match/
  )

  const wrongProjectQueue = [
    json({ baseUrl: config.siteUrl }),
    json({ id: projectPolicy.projectId, key: "OTHER" }),
  ]
  const wrongProject = new JiraClient(config, {
    fetch: async () => wrongProjectQueue.shift() as Response,
  })
  await assert.rejects(
    () => wrongProject.preflight(projectPolicy, [inputFixture().nodes[0]]),
    /project ID\/key pair no longer matches/
  )

  const unassignableQueue = [
    ...siteAndProjectResponses(),
    json({
      issueTypes: [{ id: "10001", name: "Epic", subtask: false }],
      startAt: 0,
      maxResults: 50,
      total: 1,
    }),
    json({ fields: fields(false), startAt: 0, maxResults: 50, total: 9 }),
    json({ issueLinkTypes: [{ id: "10000", name: "Blocks" }] }),
    json({ accountId: "account-1", active: true }),
    json([]),
  ]
  const unassignable = new JiraClient(config, {
    fetch: async () => unassignableQueue.shift() as Response,
  })
  await assert.rejects(
    () => unassignable.preflight(projectPolicy, [inputFixture().nodes[0]]),
    /not currently assignable/
  )
})

test("issue create sends exact allowlisted fields, deterministic property, marker, and backlink", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const input = createNodeInput(0)
  const client = new JiraClient(config, {
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      return calls.length === 1
        ? json({ id: "20001", key: "ENG-1" }, 201)
        : json(existingIssue(input))
    },
  })
  const issue = await client.createNode(input)

  assert.equal(issue.key, "ENG-1")
  assert.equal(calls.length, 2)
  assert.match(calls[0].url, /\/rest\/api\/3\/issue$/)
  const body = JSON.parse(String(calls[0].init?.body))
  assert.deepEqual(body.fields.project, { id: "10000" })
  assert.deepEqual(body.fields.issuetype, { id: "10001" })
  assert.equal(body.fields.customfield_10016, 3)
  assert.equal(body.fields.customfield_10020, 30001)
  assert(body.fields.labels.includes(input.marker))
  assert.equal(body.properties[0].key, JiraClient.PROPERTY_KEY)
  assert.equal(body.properties[0].value.planHash, input.planHash)
  assert.equal(body.properties[0].value.sourcePageId, PAGE_ID)
  assert.match(
    JSON.stringify(body.fields.description),
    /Approved implementation plan in Notion/
  )
  assert.match(JSON.stringify(body.fields.description), new RegExp(PAGE_ID))
  assert.match(calls[1].url, /\/rest\/api\/3\/issue\/20001\?/)
})

test("marker reconciliation requires exact operation property and governed fields", async () => {
  const input = createNodeInput(0)
  const queue = [
    json({ isLast: true, issues: [{ id: "20001", key: "ENG-1" }] }),
    json({
      id: "20001",
      key: "ENG-1",
      fields: {
        summary: input.node.summary,
        description: expectedDescription(input),
        issuetype: { id: input.node.issueTypeId },
        parent: null,
        labels: [...input.node.labels, input.marker],
        assignee: { accountId: input.node.assigneeAccountId },
        fixVersions: [{ id: input.node.fixVersionId }],
        customfield_10016: input.node.estimatePoints,
        customfield_10020: [{ id: input.node.sprintId }],
      },
      properties: {
        [JiraClient.PROPERTY_KEY]: {
          version: 1,
          operationId: input.operationId,
          planHash: input.planHash,
          sourcePageId: PAGE_ID,
          nodeKey: input.node.nodeKey,
        },
      },
    }),
  ]
  const client = new JiraClient(config, {
    fetch: async () => queue.shift() as Response,
  })
  const issue = await client.findNode(input)
  assert.equal(issue?.id, "20001")
  assert.equal(queue.length, 0)
})

test("multiple marker matches and drift fail closed", async () => {
  const input = createNodeInput(0)
  const multiple = new JiraClient(config, {
    fetch: async () =>
      json({
        isLast: true,
        issues: [
          { id: "20001", key: "ENG-1" },
          { id: "20002", key: "ENG-2" },
        ],
      }),
  })
  await assert.rejects(() => multiple.findNode(input), /matched multiple/)

  const queue = [
    json({ isLast: true, issues: [{ id: "20001", key: "ENG-1" }] }),
    json({
      id: "20001",
      key: "ENG-1",
      fields: {
        summary: "manually changed",
        description: expectedDescription(input),
        issuetype: { id: input.node.issueTypeId },
        parent: null,
        labels: [...input.node.labels, input.marker],
        assignee: { accountId: input.node.assigneeAccountId },
        fixVersions: [{ id: input.node.fixVersionId }],
        customfield_10016: input.node.estimatePoints,
        customfield_10020: [{ id: input.node.sprintId }],
      },
      properties: {
        [JiraClient.PROPERTY_KEY]: {
          version: 1,
          operationId: input.operationId,
          planHash: input.planHash,
          sourcePageId: PAGE_ID,
          nodeKey: input.node.nodeKey,
        },
      },
    }),
  ]
  const drift = new JiraClient(config, {
    fetch: async () => queue.shift() as Response,
  })
  await assert.rejects(() => drift.findNode(input), /has drifted/)
})

test("dependency read and write use the configured outward blocker orientation", async () => {
  const requests: RequestInit[] = []
  const queue = [
    json({
      fields: {
        issuelinks: [
          {
            type: { id: "10000", name: "Blocks" },
            outwardIssue: { id: "20002" },
          },
        ],
      },
    }),
    new Response(null, { status: 201 }),
  ]
  const client = new JiraClient(config, {
    fetch: async (_url, init) => {
      requests.push(init ?? {})
      return queue.shift() as Response
    },
  })
  const blocker = {
    id: "20001",
    key: "ENG-1",
    url: "https://example.atlassian.net/browse/ENG-1",
  }
  const blocked = {
    id: "20002",
    key: "ENG-2",
    url: "https://example.atlassian.net/browse/ENG-2",
  }
  assert.equal(await client.dependencyExists(blocker, blocked), true)
  await client.createDependency(blocker, blocked)
  const body = JSON.parse(String(requests[1].body))
  assert.deepEqual(body.outwardIssue, { id: blocker.id })
  assert.deepEqual(body.inwardIssue, { id: blocked.id })
})

test("expired auth, forbidden, not found, and conflict errors expose status only", async () => {
  for (const [status, kind] of [
    [401, "auth"],
    [403, "forbidden"],
    [404, "not_found"],
  ] as const) {
    const client = new JiraClient(config, {
      fetch: async () =>
        json({ errorMessages: ["secret provider body"] }, status),
    })
    await assert.rejects(
      () => client.findNode(createNodeInput()),
      (error: unknown) => {
        assert(error instanceof JiraError)
        assert.equal(error.kind, kind)
        assert.doesNotMatch(
          error.message,
          /secret provider body|fake-api-token-for-tests/
        )
        return true
      }
    )
  }

  const conflict = new JiraClient(config, {
    fetch: async () => json({ errors: { summary: "sensitive" } }, 422),
  })
  await assert.rejects(
    () => conflict.createNode(createNodeInput()),
    (error: unknown) => {
      assert(error instanceof JiraError)
      assert.equal(error.kind, "conflict")
      assert.equal(error.mutationUnknown, false)
      assert.doesNotMatch(error.message, /sensitive/)
      return true
    }
  )
})

test("429 honors bounded Retry-After for reads and 5xx retries only reads", async () => {
  const sleeps: number[] = []
  let calls = 0
  const client = new JiraClient(config, {
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    fetch: async () => {
      calls += 1
      return json({}, 429, { "retry-after": "7" })
    },
  })
  await assert.rejects(
    () => client.findNode(createNodeInput()),
    (error: unknown) => {
      assert(error instanceof JiraError)
      assert.equal(error.kind, "rate_limited")
      assert.equal(error.retryAfterSeconds, 7)
      return true
    }
  )
  assert.equal(calls, 2)
  assert.deepEqual(sleeps, [2_000])

  let writes = 0
  const writeClient = new JiraClient(config, {
    fetch: async () => {
      writes += 1
      return json({}, 503)
    },
  })
  await assert.rejects(
    () => writeClient.createNode(createNodeInput()),
    (error: unknown) => {
      assert(error instanceof JiraError)
      assert.equal(error.kind, "ambiguous")
      assert.equal(error.mutationUnknown, true)
      assert.equal(error.mutationDefinitelyRejected, false)
      return true
    }
  )
  assert.equal(writes, 1)
})

test("write 408 and oversized successful bodies remain outcome-unknown; documented 400 is definite", async () => {
  for (const response of [
    json({}, 408),
    new Response("x", {
      status: 201,
      headers: { "content-length": "1000001" },
    }),
  ]) {
    const client = new JiraClient(config, { fetch: async () => response })
    await assert.rejects(
      () => client.createNode(createNodeInput()),
      (error: unknown) => {
        assert(error instanceof JiraError)
        assert.equal(error.kind, "ambiguous")
        assert.equal(error.mutationUnknown, true)
        assert.equal(error.mutationDefinitelyRejected, false)
        return true
      }
    )
  }

  const rejected = new JiraClient(config, {
    fetch: async () => json({ errors: { summary: "private" } }, 400),
  })
  await assert.rejects(
    () => rejected.createNode(createNodeInput()),
    (error: unknown) => {
      assert(error instanceof JiraError)
      assert.equal(error.mutationUnknown, false)
      assert.equal(error.mutationDefinitelyRejected, true)
      assert.doesNotMatch(error.message, /private/)
      return true
    }
  )
})

test("unlisted issue and link mutation statuses remain outcome-unknown", async () => {
  for (const status of [404, 409, 413, 429]) {
    const client = new JiraClient(config, {
      fetch: async () => json({}, status),
    })
    await assert.rejects(
      () => client.createNode(createNodeInput()),
      (error: unknown) => {
        assert(error instanceof JiraError)
        assert.equal(error.mutationUnknown, true)
        assert.equal(error.mutationDefinitelyRejected, false)
        assert.equal(error.retryable, true)
        return true
      }
    )
  }
  for (const status of [403, 429]) {
    const client = new JiraClient(config, {
      fetch: async () => json({}, status),
    })
    await assert.rejects(
      () =>
        client.createDependency(
          {
            id: "20001",
            key: "ENG-1",
            url: "https://example.atlassian.net/browse/ENG-1",
          },
          {
            id: "20002",
            key: "ENG-2",
            url: "https://example.atlassian.net/browse/ENG-2",
          }
        ),
      (error: unknown) => {
        assert(error instanceof JiraError)
        assert.equal(error.mutationUnknown, true)
        assert.equal(error.mutationDefinitelyRejected, false)
        assert.equal(error.retryable, true)
        return true
      }
    )
  }
})

test("marker search fails closed when Jira reports a non-final page", async () => {
  for (const page of [
    { issues: [], nextPageToken: "opaque-next-page" },
    { issues: [] },
    { issues: [], isLast: false },
  ]) {
    const client = new JiraClient(config, {
      fetch: async () => json(page),
    })
    await assert.rejects(
      () => client.findNode(createNodeInput()),
      /did not return a final page/
    )
  }
})

test("null optional inputs mean provider default while Sprint readback requires structured lists", async () => {
  const input = createNodeInput(0)
  input.node = {
    ...input.node,
    assigneeAccountId: null,
    fixVersionId: null,
    estimatePoints: null,
    sprintId: null,
  }
  const withDefaults = existingIssue(input)
  withDefaults.fields.assignee = { accountId: "provider-default" }
  withDefaults.fields.fixVersions = [{ id: "29999" }]
  withDefaults.fields.customfield_10016 = 8
  withDefaults.fields.customfield_10020 = [{ id: 39999 }]
  const queue = [
    json({ isLast: true, issues: [{ id: "20001", key: "ENG-1" }] }),
    json(withDefaults),
  ]
  const client = new JiraClient(config, {
    fetch: async () => queue.shift() as Response,
  })
  assert.equal((await client.findNode(input))?.id, "20001")

  const governed = createNodeInput(0)
  const scalar = existingIssue(governed)
  ;(scalar.fields as Record<string, unknown>).customfield_10020 =
    governed.node.sprintId
  const scalarQueue = [
    json({ isLast: true, issues: [{ id: "20001", key: "ENG-1" }] }),
    json(scalar),
  ]
  const scalarClient = new JiraClient(config, {
    fetch: async () => scalarQueue.shift() as Response,
  })
  await assert.rejects(() => scalarClient.findNode(governed), /has drifted/)
})

test("read timeout before mutation is retryable; write timeout is ambiguous and never retried", async () => {
  let readCalls = 0
  const readClient = new JiraClient(config, {
    fetch: async () => {
      readCalls += 1
      throw new Error("network secret")
    },
  })
  await assert.rejects(
    () => readClient.findNode(createNodeInput()),
    (error: unknown) => {
      assert(error instanceof JiraError)
      assert.equal(error.kind, "unavailable")
      assert.equal(error.mutationUnknown, false)
      assert.equal(error.retryable, true)
      assert.doesNotMatch(error.message, /network secret/)
      return true
    }
  )
  assert.equal(readCalls, 2)

  let writeCalls = 0
  const writeClient = new JiraClient(config, {
    fetch: async () => {
      writeCalls += 1
      throw new Error("socket reset with secret")
    },
  })
  await assert.rejects(
    () => writeClient.createNode(createNodeInput()),
    (error: unknown) => {
      assert(error instanceof JiraError)
      assert.equal(error.kind, "ambiguous")
      assert.equal(error.mutationUnknown, true)
      assert.doesNotMatch(error.message, /socket|secret/)
      return true
    }
  )
  assert.equal(writeCalls, 1)
})

test("malformed successful create response is treated as ambiguous", async () => {
  const client = new JiraClient(config, {
    fetch: async () => json({ id: "not-numeric", key: "OTHER-1" }, 201),
  })
  await assert.rejects(
    () => client.createNode(createNodeInput()),
    (error: unknown) => {
      assert(error instanceof JiraError)
      assert.equal(error.mutationUnknown, true)
      return true
    }
  )
})

test("provider execution deadline stops before another network request", async () => {
  let now = 0
  let fetches = 0
  const client = new JiraClient(config, {
    now: () => now,
    fetch: async () => {
      fetches += 1
      return json({ isLast: true, issues: [] })
    },
  })
  now = JiraClient.MAX_EXECUTION_MS + 1
  await assert.rejects(
    () => client.findNode(createNodeInput()),
    /execution time budget was exhausted/
  )
  assert.equal(fetches, 0)
})

test("oversized Jira response bodies are rejected before parsing", async () => {
  const client = new JiraClient(config, {
    fetch: async () =>
      new Response("x", {
        status: 200,
        headers: { "content-length": "1000001" },
      }),
  })
  await assert.rejects(
    () => client.findNode(createNodeInput()),
    /exceeded the fixed body limit/
  )
})
