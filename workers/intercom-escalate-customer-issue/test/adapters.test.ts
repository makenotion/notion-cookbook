import assert from "node:assert/strict"
import { test } from "node:test"

import type { RuntimeConfig } from "../src/config.js"
import {
  IntercomClient,
  intercomNoteDigest,
  normalizeIntercomConversationReference,
} from "../src/intercom.js"
import { requestJson, type FetchLike } from "../src/http.js"
import {
  createTicketPage,
  NotionAdapterError,
  NotionCreateError,
  type NotionClientLike,
  queryTicketsBySourceKey,
  resolveSyncedConversationPage,
  retrieveAndVerifyTicketPage,
  retrieveTicketDataSourceSchema,
  type TicketDataSourceSchema,
} from "../src/notion.js"
import { ProviderError, WorkflowError } from "../src/types.js"

const DATA_SOURCE_ID = "11111111-1111-4111-8111-111111111111"
const CONVERSATION_DATA_SOURCE_ID = "22222222-2222-4222-8222-222222222222"
const CONVERSATION_PAGE_ID = "33333333-3333-4333-8333-333333333333"
const TICKET_PAGE_ID = "44444444-4444-4444-8444-444444444444"
const SOURCE_KEY = "intercom:workspace_1:conversation:123"

const config: RuntimeConfig = {
  intercomToken: "secret_intercom_token",
  intercomRegion: "us",
  intercomWorkspaceId: "workspace_1",
  intercomAdminId: "admin_1",
  intercomTeamId: "team_escalations",
  intercomTagId: "tag_escalated",
  notionTicketsDataSourceId: DATA_SOURCE_ID,
  requestTimeoutMs: 8_000,
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function customerPart(
  id: string,
  createdAt: number,
  body: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    type: "conversation_part",
    id,
    part_type: "comment",
    created_at: createdAt,
    redacted: false,
    body,
    author: { type: "user", id: "contact_1" },
    ...overrides,
  }
}

function intercomConversation(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [
    customerPart("part_1", 1_700_000_001, "Oldest customer message"),
    customerPart("part_admin", 1_700_000_002, "Public support reply", {
      author: { type: "admin", id: "admin_2" },
    }),
    customerPart("part_note", 1_700_000_003, "<p>Private note</p>", {
      part_type: "note",
      author: { type: "admin", id: "admin_2" },
    }),
    customerPart("part_redacted", 1_700_000_004, "Redacted secret", {
      redacted: true,
    }),
    customerPart("part_5", 1_700_000_005, "Message five"),
    customerPart("part_6", 1_700_000_006, "Message six"),
    customerPart("part_7", 1_700_000_007, "Message seven"),
    customerPart("part_8", 1_700_000_008, "Message eight"),
    customerPart(
      "part_9",
      1_700_000_009,
      "See https://private.example/path?token=secret and email person@example.com"
    ),
    customerPart("part_10", 1_700_000_010, "x".repeat(1_500)),
  ]

  return {
    type: "conversation",
    id: "123",
    created_at: 1_700_000_000,
    updated_at: 1_700_000_100,
    state: "open",
    priority: "not_priority",
    open: true,
    waiting_since: null,
    title: "<b>Checkout failure</b>",
    source: {
      type: "conversation",
      redacted: false,
      body: "<p>Checkout fails at https://shop.example/checkout?token=secret for me@example.com</p>",
      author: { type: "contact", id: "contact_1" },
    },
    contacts: {
      type: "contact.list",
      contacts: [{ type: "contact", id: "contact_1" }],
    },
    company: { type: "company", id: "company_1" },
    team_assignee_id: "team_inbox",
    admin_assignee_id: null,
    sla_applied: { sla_status: "missed" },
    tags: {
      type: "tag.list",
      tags: [{ type: "tag", id: "tag_vip", name: "VIP" }],
    },
    conversation_parts: {
      type: "conversation_part.list",
      conversation_parts: parts,
      total_count: parts.length + 1,
    },
    ...overrides,
  }
}

function intercomClient(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>
): IntercomClient {
  const fetchFn: FetchLike = async (input, init = {}) =>
    responder(String(input), init)
  return new IntercomClient(config, {
    fetchFn,
    sleep: async () => undefined,
  })
}

function ticketProperties(): Record<string, unknown> {
  return {
    Name: { id: "title_prop", name: "Name", type: "title", title: {} },
    "Intercom source key": {
      id: "source_prop",
      name: "Intercom source key",
      type: "rich_text",
      rich_text: {},
    },
    Priority: {
      id: "priority_prop",
      name: "Priority",
      type: "select",
      select: {
        options: [
          { id: "priority_p0", name: "P0", color: "red" },
          { id: "priority_p1", name: "P1", color: "orange" },
          { id: "priority_p2", name: "P2", color: "yellow" },
          { id: "priority_p3", name: "P3", color: "gray" },
        ],
      },
    },
    Customer: {
      id: "customer_prop",
      name: "Customer",
      type: "rich_text",
      rich_text: {},
    },
    Company: {
      id: "company_prop",
      name: "Company",
      type: "rich_text",
      rich_text: {},
    },
    "Intercom updated": {
      id: "updated_prop",
      name: "Intercom updated",
      type: "date",
      date: {},
    },
  }
}

function dataSource(
  properties: Record<string, unknown> = ticketProperties()
): Record<string, unknown> {
  return {
    object: "data_source",
    id: DATA_SOURCE_ID,
    archived: false,
    in_trash: false,
    properties,
  }
}

function richTextProperty(value: string): Record<string, unknown> {
  return {
    type: "rich_text",
    rich_text: [{ type: "text", plain_text: value }],
  }
}

function fullPage(input: {
  id: string
  dataSourceId: string
  properties: Record<string, unknown>
  url?: string
}): Record<string, unknown> {
  return {
    object: "page",
    id: input.id,
    created_time: "2026-07-05T16:00:00.000Z",
    last_edited_time: "2026-07-05T17:00:00.000Z",
    archived: false,
    in_trash: false,
    is_archived: false,
    parent: {
      type: "data_source_id",
      data_source_id: input.dataSourceId,
    },
    properties: input.properties,
    url: input.url ?? `https://www.notion.so/${input.id.replaceAll("-", "")}`,
  }
}

function syncedConversationPage(): Record<string, unknown> {
  return fullPage({
    id: CONVERSATION_PAGE_ID,
    dataSourceId: CONVERSATION_DATA_SOURCE_ID,
    properties: {
      "Conversation ID": richTextProperty("conversation_123"),
    },
  })
}

function ticketPage(): Record<string, unknown> {
  return fullPage({
    id: TICKET_PAGE_ID,
    dataSourceId: DATA_SOURCE_ID,
    properties: {
      "Intercom source key": richTextProperty(SOURCE_KEY),
    },
  })
}

function unused(name: string): () => Promise<never> {
  return async () => {
    throw new Error(`Unexpected Notion call: ${name}`)
  }
}

function notionClient(input: {
  retrieveDataSource?: NotionClientLike["dataSources"]["retrieve"]
  query?: NotionClientLike["dataSources"]["query"]
  retrievePage?: NotionClientLike["pages"]["retrieve"]
  createPage?: NotionClientLike["pages"]["create"]
}): NotionClientLike {
  return {
    dataSources: {
      retrieve: input.retrieveDataSource ?? unused("dataSources.retrieve"),
      query: input.query ?? unused("dataSources.query"),
    },
    pages: {
      retrieve: input.retrievePage ?? unused("pages.retrieve"),
      create: input.createPage ?? unused("pages.create"),
    },
  }
}

const schema: TicketDataSourceSchema = {
  dataSourceId: DATA_SOURCE_ID,
  title: { id: "title_prop", name: "Name" },
  sourceKey: { id: "source_prop", name: "Intercom source key" },
  priority: { id: "priority_prop", name: "Priority" },
  customer: { id: "customer_prop", name: "Customer" },
  company: { id: "company_prop", name: "Company" },
  intercomUpdated: { id: "updated_prop", name: "Intercom updated" },
  priorityOptionIds: {
    P0: "priority_p0",
    P1: "priority_p1",
    P2: "priority_p2",
    P3: "priority_p3",
  },
}

test("Intercom normalizes raw, MCP-prefixed, and canonical Inbox references", () => {
  const expected = { region: "us" as const, workspaceId: "workspace_1" }
  assert.equal(normalizeIntercomConversationReference("123"), "123")
  assert.equal(
    normalizeIntercomConversationReference("conversation_123"),
    "123"
  )
  const canonical = normalizeIntercomConversationReference("conversation_123")
  assert.equal(normalizeIntercomConversationReference(canonical), canonical)
  assert.equal(
    normalizeIntercomConversationReference(
      "https://app.intercom.com/a/inbox/workspace_1/inbox/shared/all/conversation/123",
      expected
    ),
    "123"
  )

  for (const reference of [
    "https://app.intercom.com/a/inbox/workspace_2/inbox/shared/all/conversation/123",
    "https://app.eu.intercom.com/a/inbox/workspace_1/inbox/shared/all/conversation/123",
  ]) {
    assert.throws(
      () => normalizeIntercomConversationReference(reference, expected),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === "INTERCOM_REFERENCE_MISMATCH" &&
        error.status === "conflict"
    )
  }
  for (const reference of [
    "conversation_conversation_123",
    "https://app.intercom.com/a/inbox/workspace_1/inbox/shared/all/conversation/conversation_conversation_123",
  ]) {
    assert.throws(
      () => normalizeIntercomConversationReference(reference, expected),
      (error: unknown) =>
        error instanceof WorkflowError && error.code === "INVALID_INPUT"
    )
  }
})

test("Intercom parses a bounded public timeline and excludes private content", async () => {
  const client = intercomClient((url, init) => {
    assert.equal(
      url,
      "https://api.intercom.io/conversations/123?display_as=plaintext"
    )
    assert.equal(init.method, undefined)
    const headers = new Headers(init.headers)
    assert.equal(headers.get("intercom-version"), "2.15")
    assert.equal(headers.get("authorization"), "Bearer secret_intercom_token")
    return jsonResponse(intercomConversation())
  })

  const snapshot = await client.getConversation("conversation_123")

  assert.equal(snapshot.id, "123")
  assert.equal(snapshot.title, "Checkout failure")
  assert.match(
    snapshot.openingMessage ?? "",
    /https:\/\/shop\.example\/checkout/
  )
  assert.equal(snapshot.openingMessage?.includes("token=secret"), false)
  assert.equal(snapshot.openingMessage?.includes("me@example.com"), false)
  assert.match(snapshot.openingMessage ?? "", /\[email omitted\]/)
  assert.equal(snapshot.customerEvidence.length, 8)
  assert.deepEqual(
    snapshot.customerEvidence.map(({ partId }) => partId),
    [
      "part_10",
      "part_9",
      "part_8",
      "part_7",
      "part_6",
      "part_5",
      "part_admin",
      "part_1",
    ]
  )
  assert.equal(snapshot.customerEvidence[0].text.length, 1_200)
  assert.match(
    snapshot.customerEvidence[1].text,
    /https:\/\/private\.example\/path/
  )
  assert.equal(
    snapshot.customerEvidence[1].text.includes("token=secret"),
    false
  )
  assert.equal(
    snapshot.customerEvidence[1].text.includes("person@example.com"),
    false
  )
  assert.equal(snapshot.customerEvidence[6].role, "support")
  assert.equal(snapshot.evidenceTruncated, true)
  assert.equal(snapshot.partsTruncated, true)
  assert.deepEqual(snapshot.internalNoteDigests, [
    {
      partId: "part_note",
      digest: intercomNoteDigest("<p>Private note</p>"),
    },
  ])
  const exposed = JSON.stringify({
    openingMessage: snapshot.openingMessage,
    customerEvidence: snapshot.customerEvidence,
  })
  assert.match(exposed, /Public support reply/)
  assert.doesNotMatch(exposed, /Private note|Redacted secret/)
})

test("Intercom safely degrades missing, nullable, and overlong bodies", async () => {
  const missingSourceBody = intercomConversation()
  delete (missingSourceBody.source as Record<string, unknown>).body
  const missingSourceSnapshot = await intercomClient(() =>
    jsonResponse(missingSourceBody)
  ).getConversation("123")
  assert.equal(missingSourceSnapshot.openingMessage, null)

  const overlongBody = "x".repeat(40_001)
  const parts = [
    customerPart("part_missing", 1, "unused", { body: undefined }),
    customerPart("part_null", 2, "unused", { body: null }),
    customerPart("part_long", 3, overlongBody),
    customerPart("part_long_note", 4, overlongBody, {
      part_type: "note",
      author: { type: "admin", id: "admin_2" },
    }),
  ]
  const snapshot = await intercomClient(() =>
    jsonResponse(
      intercomConversation({
        source: {
          type: "conversation",
          redacted: false,
          body: overlongBody,
          author: { type: "contact", id: "contact_1" },
        },
        conversation_parts: {
          type: "conversation_part.list",
          conversation_parts: parts,
          total_count: parts.length,
        },
      })
    )
  ).getConversation("123")

  assert.equal(snapshot.openingMessage?.length, 1_200)
  assert.deepEqual(snapshot.customerEvidence, [
    {
      partId: "part_long",
      createdAt: 3,
      role: "customer",
      text: "x".repeat(1_200),
    },
  ])
  assert.equal(snapshot.evidenceTruncated, true)
  assert.equal(snapshot.partsTruncated, false)
  assert.deepEqual(snapshot.internalNoteDigests, [])
})

test("Intercom rejects missing required collections and over-bound part lists", async () => {
  const optionalFields = intercomConversation({
    conversation_parts: {
      type: "conversation_part.list",
      conversation_parts: [
        customerPart("long", 1, "x".repeat(1_201)),
        customerPart("bot", 2, "Automated public reply", {
          author: { type: "bot", id: "bot_1" },
        }),
        customerPart("team", 3, "Team public reply", {
          author: { type: "team", id: "team_1" },
        }),
      ],
      total_count: 3,
    },
  })
  delete optionalFields.company
  delete optionalFields.open
  delete optionalFields.priority
  const optionalSnapshot = await intercomClient(() =>
    jsonResponse(optionalFields)
  ).getConversation("conversation_123")
  assert.equal(optionalSnapshot.companyId, null)
  assert.equal(optionalSnapshot.priority, false)
  assert.equal(optionalSnapshot.evidenceTruncated, true)
  assert.deepEqual(
    optionalSnapshot.customerEvidence.map(({ partId, role }) => ({
      partId,
      role,
    })),
    [
      { partId: "team", role: "support" },
      { partId: "bot", role: "support" },
      { partId: "long", role: "customer" },
    ]
  )

  const missingTags = intercomConversation()
  delete missingTags.tags
  await assert.rejects(
    intercomClient(() => jsonResponse(missingTags)).getConversation(
      "conversation_123"
    ),
    (error: unknown) =>
      error instanceof WorkflowError &&
      error.code === "INVALID_PROVIDER_RESPONSE"
  )

  const tooManyParts = intercomConversation({
    conversation_parts: {
      type: "conversation_part.list",
      conversation_parts: Array.from({ length: 501 }, (_, index) =>
        customerPart(`part_${index}`, index, "text")
      ),
      total_count: 501,
    },
  })
  await assert.rejects(
    intercomClient(() => jsonResponse(tooManyParts)).getConversation(
      "conversation_123"
    ),
    (error: unknown) =>
      error instanceof WorkflowError &&
      error.code === "INVALID_PROVIDER_RESPONSE"
  )
})

test("Intercom mutations use the exact v2.15 endpoints and request bodies", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const responses = [
    { type: "tag", id: "tag_escalated" },
    {
      type: "conversation",
      id: "123",
      team_assignee_id: "team_escalations",
    },
    { type: "conversation", id: "123" },
  ]
  const client = intercomClient((url, init) => {
    calls.push({ url, init })
    const response = responses.shift()
    assert.ok(response)
    return jsonResponse(response)
  })

  await client.addTag("conversation_123", "tag_escalated")
  await client.routeToTeam("conversation_123", "team_escalations")
  await client.addInternalNote(
    "conversation_123",
    "Notion ticket: https://notion.so/ticket"
  )

  assert.equal(calls.length, 3)
  assert.deepEqual(
    calls.map(({ url, init }) => ({
      url,
      method: init.method,
      body: JSON.parse(String(init.body)) as unknown,
    })),
    [
      {
        url: "https://api.intercom.io/conversations/123/tags",
        method: "POST",
        body: { id: "tag_escalated", admin_id: "admin_1" },
      },
      {
        url: "https://api.intercom.io/conversations/123/parts",
        method: "POST",
        body: {
          message_type: "assignment",
          type: "team",
          admin_id: "admin_1",
          assignee_id: "team_escalations",
        },
      },
      {
        url: "https://api.intercom.io/conversations/123/reply",
        method: "POST",
        body: {
          message_type: "note",
          type: "admin",
          admin_id: "admin_1",
          body: "Notion ticket: https://notion.so/ticket",
        },
      },
    ]
  )
  for (const { init } of calls) {
    const headers = new Headers(init.headers)
    assert.equal(headers.get("intercom-version"), "2.15")
    assert.equal(headers.get("content-type"), "application/json")
  }
})

test("Intercom read transport retries 408 and oversized 500 responses", async () => {
  for (const scenario of ["timeout", "oversized"] as const) {
    let calls = 0
    let sleeps = 0
    const fetchFn: FetchLike = async () => {
      calls += 1
      return scenario === "timeout"
        ? new Response("timed out", { status: 408 })
        : new Response(`secret-${"x".repeat(200)}`, { status: 500 })
    }
    await assert.rejects(
      requestJson(
        "Intercom",
        "https://api.intercom.io/test",
        {},
        {
          fetchFn,
          timeoutMs: 1_000,
          sleep: async () => {
            sleeps += 1
          },
          maximumBytes: 32,
          mutation: false,
          expectedStatuses: [200],
        }
      ),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        assert.equal(error.retryable, true)
        assert.doesNotMatch(error.message, /secret-/)
        return true
      }
    )
    assert.equal(calls, 3)
    assert.equal(sleeps, 2)
  }
})

test("Notion validates the fixed ticket data-source contract", async () => {
  const calls: unknown[] = []
  const notion = notionClient({
    retrieveDataSource: async (args) => {
      calls.push(args)
      return dataSource()
    },
  })

  const result = await retrieveTicketDataSourceSchema(notion, DATA_SOURCE_ID)

  assert.deepEqual(calls, [{ data_source_id: DATA_SOURCE_ID }])
  assert.deepEqual(result, schema)

  const invalidProperties = ticketProperties()
  invalidProperties.Priority = {
    id: "priority_prop",
    name: "Priority",
    type: "select",
    select: {
      options: [
        { id: "priority_p0", name: "P0" },
        { id: "priority_p1", name: "P1" },
        { id: "priority_p2", name: "P2" },
        { id: "priority_urgent", name: "Urgent" },
      ],
    },
  }
  await assert.rejects(
    retrieveTicketDataSourceSchema(
      notionClient({
        retrieveDataSource: async () => dataSource(invalidProperties),
      }),
      DATA_SOURCE_ID
    ),
    (error: unknown) =>
      error instanceof NotionAdapterError &&
      error.code === "NOTION_SCHEMA_INVALID"
  )
})

test("Notion read retryability distinguishes deterministic and transient failures", async () => {
  const cases: Array<{ status: number | null; retryable: boolean }> = [
    { status: 400, retryable: false },
    { status: 401, retryable: false },
    { status: 403, retryable: false },
    { status: 404, retryable: false },
    { status: 408, retryable: true },
    { status: 409, retryable: true },
    { status: 429, retryable: true },
    { status: 500, retryable: true },
    { status: null, retryable: true },
  ]

  for (const { status, retryable } of cases) {
    await assert.rejects(
      retrieveTicketDataSourceSchema(
        notionClient({
          retrieveDataSource: async () => {
            const error = new Error("Notion read failed") as Error & {
              status?: number
            }
            if (status !== null) error.status = status
            throw error
          },
        }),
        DATA_SOURCE_ID
      ),
      (error: unknown) =>
        error instanceof NotionAdapterError &&
        error.code === "NOTION_UNAVAILABLE" &&
        error.retryable === retryable,
      `unexpected retryability for status ${String(status)}`
    )
  }
})

test("Notion resolves a synced conversation page and its stable Intercom ID", async () => {
  const calls: unknown[] = []
  const result = await resolveSyncedConversationPage(
    notionClient({
      retrievePage: async (args) => {
        calls.push(args)
        return syncedConversationPage()
      },
    }),
    CONVERSATION_PAGE_ID
  )

  assert.deepEqual(calls, [
    { page_id: CONVERSATION_PAGE_ID.replaceAll("-", "") },
  ])
  assert.equal(result.pageId, CONVERSATION_PAGE_ID)
  assert.equal(result.conversationId, "conversation_123")
})

test("Notion queries by the source property ID with a two-result uniqueness bound", async () => {
  const calls: unknown[] = []
  const result = await queryTicketsBySourceKey(
    notionClient({
      query: async (args) => {
        calls.push(args)
        return {
          object: "list",
          results: [ticketPage()],
          has_more: false,
          next_cursor: null,
          request_status: { type: "complete" },
        }
      },
    }),
    schema,
    SOURCE_KEY
  )

  assert.deepEqual(calls, [
    {
      data_source_id: DATA_SOURCE_ID,
      filter: {
        property: "source_prop",
        rich_text: { equals: SOURCE_KEY },
      },
      page_size: 2,
      result_type: "page",
    },
  ])
  assert.deepEqual(result, [
    {
      pageId: TICKET_PAGE_ID,
      pageUrl: `https://www.notion.so/${TICKET_PAGE_ID.replaceAll("-", "")}`,
      sourceKey: SOURCE_KEY,
    },
  ])
})

test("Notion creates with property IDs, structured blocks, and verified readback", async () => {
  const createCalls: NotionClientLike["pages"]["create"] extends (
    args: infer T
  ) => Promise<unknown>
    ? T[]
    : never = []
  const retrieveCalls: unknown[] = []
  const result = await createTicketPage(
    notionClient({
      createPage: async (args) => {
        createCalls.push(args)
        return { object: "page", id: TICKET_PAGE_ID }
      },
      retrievePage: async (args) => {
        retrieveCalls.push(args)
        return ticketPage()
      },
    }),
    {
      schema,
      sourceKey: SOURCE_KEY,
      title: "Checkout fails for annual plans",
      priority: "P1",
      customer: "Pat Customer",
      company: null,
      intercomUpdatedAt: "2026-07-05T17:00:00.000Z",
      body: {
        summary: "Annual-plan checkout fails after confirming payment.",
        impact: "The customer cannot complete a renewal.",
        environment: "Production · Chrome 126",
        reproductionSteps: ["Open checkout", "Confirm payment"],
        evidence: ["The confirmation button spins forever."],
        intercomUrl:
          "https://app.intercom.com/a/inbox/workspace_1/inbox/conversation/conversation_123",
      },
    }
  )

  assert.deepEqual(retrieveCalls, [{ page_id: TICKET_PAGE_ID }])
  assert.equal(result.pageId, TICKET_PAGE_ID)
  assert.equal(createCalls.length, 1)
  const request = createCalls[0]
  assert.deepEqual(request.parent, {
    type: "data_source_id",
    data_source_id: DATA_SOURCE_ID,
  })
  assert.deepEqual(request.properties, {
    title_prop: {
      title: [
        { type: "text", text: { content: "Checkout fails for annual plans" } },
      ],
    },
    source_prop: {
      rich_text: [{ type: "text", text: { content: SOURCE_KEY } }],
    },
    priority_prop: { select: { id: "priority_p1" } },
    customer_prop: {
      rich_text: [{ type: "text", text: { content: "Pat Customer" } }],
    },
    company_prop: { rich_text: [] },
    updated_prop: { date: { start: "2026-07-05T17:00:00.000Z" } },
  })
  assert.deepEqual(
    request.children.map((block) => (block as { type: string }).type),
    [
      "heading_2",
      "paragraph",
      "heading_2",
      "paragraph",
      "heading_2",
      "paragraph",
      "heading_2",
      "numbered_list_item",
      "numbered_list_item",
      "heading_2",
      "quote",
      "heading_2",
      "paragraph",
    ]
  )
  assert.match(JSON.stringify(request.children), /Open the source conversation/)
})

test("Notion verifies mapped tickets against both destination and source", async () => {
  const wrongSource = ticketPage()
  ;(wrongSource.properties as Record<string, unknown>)["Intercom source key"] =
    richTextProperty("intercom:other")

  await assert.rejects(
    retrieveAndVerifyTicketPage(
      notionClient({ retrievePage: async () => wrongSource }),
      schema,
      TICKET_PAGE_ID,
      SOURCE_KEY
    ),
    (error: unknown) =>
      error instanceof NotionAdapterError &&
      error.code === "NOTION_TICKET_MISMATCH"
  )
})

test("Notion distinguishes definite create rejection from unknown outcome", async () => {
  const input = {
    schema,
    sourceKey: SOURCE_KEY,
    title: "Checkout fails",
    priority: "P1" as const,
    customer: null,
    company: null,
    intercomUpdatedAt: "2026-07-05T17:00:00.000Z",
    body: {
      summary: "Checkout fails.",
      impact: "Renewal is blocked.",
      environment: null,
      reproductionSteps: [],
      evidence: [],
      intercomUrl: "https://app.intercom.com/conversation/conversation_123",
    },
  }

  await assert.rejects(
    createTicketPage(
      notionClient({
        createPage: async () => {
          throw Object.assign(new Error("validation failed"), { status: 400 })
        },
      }),
      input
    ),
    (error: unknown) =>
      error instanceof NotionCreateError &&
      error.disposition === "definite_rejection" &&
      error.retryable === false
  )

  await assert.rejects(
    createTicketPage(
      notionClient({
        createPage: async () => {
          throw Object.assign(new Error("transaction conflict"), {
            status: 409,
          })
        },
      }),
      input
    ),
    (error: unknown) =>
      error instanceof NotionCreateError &&
      error.disposition === "definite_rejection" &&
      error.retryable === true
  )

  await assert.rejects(
    createTicketPage(
      notionClient({
        createPage: async () => {
          throw Object.assign(new Error("rate limited"), { status: 429 })
        },
      }),
      input
    ),
    (error: unknown) =>
      error instanceof NotionCreateError &&
      error.disposition === "definite_rejection" &&
      error.retryable === true
  )

  await assert.rejects(
    createTicketPage(
      notionClient({
        createPage: async () => {
          throw Object.assign(new Error("request timed out"), { status: 408 })
        },
      }),
      input
    ),
    (error: unknown) =>
      error instanceof NotionCreateError &&
      error.disposition === "outcome_unknown" &&
      error.retryable === true
  )

  await assert.rejects(
    createTicketPage(
      notionClient({ createPage: async () => ({ object: "page" }) }),
      input
    ),
    (error: unknown) =>
      error instanceof NotionCreateError &&
      error.disposition === "outcome_unknown"
  )

  await assert.rejects(
    createTicketPage(
      notionClient({
        createPage: async () => ({ object: "page", id: TICKET_PAGE_ID }),
        retrievePage: async () => {
          throw Object.assign(new Error("readback unavailable"), {
            status: 503,
          })
        },
      }),
      input
    ),
    (error: unknown) =>
      error instanceof NotionCreateError &&
      error.disposition === "outcome_unknown" &&
      error.pageId === TICKET_PAGE_ID
  )
})
