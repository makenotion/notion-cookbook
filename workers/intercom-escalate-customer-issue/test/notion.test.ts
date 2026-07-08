import assert from "node:assert/strict"
import { test } from "node:test"

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

const DATA_SOURCE_ID = "11111111-1111-4111-8111-111111111111"
const CONVERSATION_DATA_SOURCE_ID = "22222222-2222-4222-8222-222222222222"
const CONVERSATION_PAGE_ID = "33333333-3333-4333-8333-333333333333"
const TICKET_PAGE_ID = "44444444-4444-4444-8444-444444444444"
const SOURCE_KEY = "intercom:workspace_1:conversation:123"

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
