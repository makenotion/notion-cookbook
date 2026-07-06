import assert from "node:assert/strict"
import test from "node:test"
import type { RuntimeConfig } from "../src/config.js"
import worker from "../src/index.js"
import {
  intercomNoteDigest,
  type ConversationSnapshot,
} from "../src/intercom.js"
import type { NotionClientLike } from "../src/notion.js"
import type { CreateTicketInput, TicketDraft } from "../src/types.js"
import { ProviderError, WorkflowError } from "../src/types.js"
import {
  conversationInspectionVersion,
  createNotionTicket,
  inspectIntercomConversation,
  sourceKey,
  ticketNoteBody,
  type WorkflowDependencies,
} from "../src/workflow.js"

const TICKETS_DATA_SOURCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const SOURCE_DATA_SOURCE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const SOURCE_PAGE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const FIRST_TICKET_PAGE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const SECOND_TICKET_PAGE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const CONVERSATION_ID = "123"
const ORIGINAL_TEAM_ID = "support-team"
const TARGET_TEAM_ID = "engineering-team"
const TARGET_TAG_ID = "escalated-to-engineering"
const UPDATED_AT = 1_773_014_400

const config: RuntimeConfig = {
  intercomToken: "test-token",
  intercomRegion: "us",
  intercomWorkspaceId: "workspace-123",
  intercomAdminId: "admin-123",
  intercomTeamId: TARGET_TEAM_ID,
  intercomTagId: TARGET_TAG_ID,
  notionTicketsDataSourceId: TICKETS_DATA_SOURCE_ID,
  requestTimeoutMs: 8_000,
}

const SOURCE_KEY = sourceKey(config.intercomWorkspaceId, CONVERSATION_ID)

const ticketDraft: TicketDraft = {
  title: "Export drops the final row",
  priority: "P1",
  summary: "Large exports omit the final row.",
  impact: "The customer cannot reconcile monthly billing exports.",
  environment: "Production, Chrome 134",
  reproductionSteps: [
    "Create an export with more than 10,000 rows.",
    "Compare the last row with the source data.",
  ],
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function schemaError(path: string, message: string): never {
  throw new Error(`${path} ${message}`)
}

function assertMatchesSchema(
  value: unknown,
  schema: unknown,
  path = "$"
): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    schemaError(path, "has an invalid test schema")
  }
  const rule = schema as Record<string, unknown>
  if (Array.isArray(rule.anyOf)) {
    if (
      !rule.anyOf.some((candidate) => {
        try {
          assertMatchesSchema(value, candidate, path)
          return true
        } catch {
          return false
        }
      })
    ) {
      schemaError(path, "matches no schema branch")
    }
    return
  }
  if (Array.isArray(rule.enum) && !rule.enum.includes(value)) {
    schemaError(path, "is not an allowed enum value")
  }
  switch (rule.type) {
    case "null":
      if (value !== null) schemaError(path, "is not null")
      return
    case "string":
      if (typeof value !== "string") schemaError(path, "is not a string")
      return
    case "boolean":
      if (typeof value !== "boolean") schemaError(path, "is not a boolean")
      return
    case "integer":
      if (!Number.isSafeInteger(value)) schemaError(path, "is not an integer")
      return
    case "array":
      if (!Array.isArray(value)) schemaError(path, "is not an array")
      value.forEach((item, index) =>
        assertMatchesSchema(item, rule.items, `${path}[${index}]`)
      )
      return
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        schemaError(path, "is not an object")
      }
      const object = value as Record<string, unknown>
      const properties = rule.properties as Record<string, unknown>
      const required = Array.isArray(rule.required)
        ? (rule.required as string[])
        : []
      for (const name of required) {
        if (!(name in object)) schemaError(`${path}.${name}`, "is missing")
      }
      if (
        rule.additionalProperties === false &&
        Object.keys(object).some((name) => !(name in properties))
      ) {
        schemaError(path, "contains an undeclared property")
      }
      for (const [name, item] of Object.entries(object)) {
        if (name in properties) {
          assertMatchesSchema(item, properties[name], `${path}.${name}`)
        }
      }
      return
    }
    default:
      schemaError(path, `uses unsupported schema type ${String(rule.type)}`)
  }
}

function assertToolOutput(capabilityIndex: number, value: unknown): void {
  const capability = worker.manifest.capabilities[capabilityIndex]
  assert.ok(capability && capability._tag === "tool")
  const config = capability.config as unknown as { outputSchema: unknown }
  assertMatchesSchema(value, config.outputSchema)
}

function baseConversation(): ConversationSnapshot {
  return {
    id: CONVERSATION_ID,
    createdAt: UPDATED_AT - 600,
    updatedAt: UPDATED_AT,
    state: "open",
    priority: true,
    title: "CSV export is missing data",
    openingMessage: "Our export is one row short.",
    contactIds: ["contact-123"],
    companyId: "company-123",
    teamAssigneeId: ORIGINAL_TEAM_ID,
    slaStatus: "hit",
    tags: [{ id: "vip", name: "VIP" }],
    customerEvidence: [
      {
        partId: "part-123",
        createdAt: UPDATED_AT - 120,
        role: "customer",
        text: "It happens on every large export.",
      },
    ],
    evidenceTruncated: false,
    partsTruncated: false,
    internalNoteDigests: [],
  }
}

function ticketSchemaResponse(): Record<string, unknown> {
  return {
    object: "data_source",
    id: TICKETS_DATA_SOURCE_ID,
    in_trash: false,
    archived: false,
    properties: {
      Name: { id: "title", name: "Name", type: "title", title: {} },
      "Intercom source key": {
        id: "source",
        name: "Intercom source key",
        type: "rich_text",
        rich_text: {},
      },
      Priority: {
        id: "priority",
        name: "Priority",
        type: "select",
        select: {
          options: ["P0", "P1", "P2", "P3"].map((name) => ({
            id: `option-${name.toLowerCase()}`,
            name,
          })),
        },
      },
      Customer: {
        id: "customer",
        name: "Customer",
        type: "rich_text",
        rich_text: {},
      },
      Company: {
        id: "company",
        name: "Company",
        type: "rich_text",
        rich_text: {},
      },
      "Intercom updated": {
        id: "updated",
        name: "Intercom updated",
        type: "date",
        date: {},
      },
    },
  }
}

function richTextProperty(value: string): Record<string, unknown> {
  return {
    type: "rich_text",
    rich_text: [{ type: "text", plain_text: value, text: { content: value } }],
  }
}

function ticketPage(pageId: string, key: string): Record<string, unknown> {
  return {
    object: "page",
    id: pageId,
    parent: {
      type: "data_source_id",
      data_source_id: TICKETS_DATA_SOURCE_ID,
    },
    in_trash: false,
    is_archived: false,
    archived: false,
    url: `https://www.notion.so/${pageId.replaceAll("-", "")}`,
    last_edited_time: "2026-07-05T16:00:00.000Z",
    properties: {
      "Intercom source key": richTextProperty(key),
    },
  }
}

function sourcePage(): Record<string, unknown> {
  return {
    object: "page",
    id: SOURCE_PAGE_ID,
    parent: {
      type: "data_source_id",
      data_source_id: SOURCE_DATA_SOURCE_ID,
    },
    in_trash: false,
    is_archived: false,
    archived: false,
    url: `https://www.notion.so/${SOURCE_PAGE_ID.replaceAll("-", "")}`,
    last_edited_time: "2026-07-05T16:00:00.000Z",
    properties: {
      "Conversation ID": richTextProperty(`conversation_${CONVERSATION_ID}`),
    },
  }
}

function requestRichText(value: unknown): string {
  if (!Array.isArray(value)) return ""
  return value
    .map((fragment) => {
      if (!fragment || typeof fragment !== "object") return ""
      const text = (fragment as Record<string, unknown>).text
      if (!text || typeof text !== "object") return ""
      const content = (text as Record<string, unknown>).content
      return typeof content === "string" ? content : ""
    })
    .join("")
}

type QueryArgs = Parameters<NotionClientLike["dataSources"]["query"]>[0]
type CreatePageArgs = Parameters<NotionClientLike["pages"]["create"]>[0]

class FakeNotion implements NotionClientLike {
  readonly tickets = new Map<string, Record<string, unknown>>()
  readonly createCalls: CreatePageArgs[] = []
  readonly queryCalls: QueryArgs[] = []
  createError: unknown = null
  persistBeforeCreateError = false
  ticketRetrieveFailures = 0
  queryView?: (
    call: number,
    matches: Record<string, unknown>[]
  ) => Record<string, unknown>[]

  seedTicket(
    pageId = FIRST_TICKET_PAGE_ID,
    key = SOURCE_KEY
  ): Record<string, unknown> {
    const page = ticketPage(pageId, key)
    this.tickets.set(pageId, page)
    return page
  }

  private matchingTickets(key: string): Record<string, unknown>[] {
    return [...this.tickets.values()].filter((page) => {
      const properties = page.properties as Record<string, unknown>
      const property = properties["Intercom source key"] as Record<
        string,
        unknown
      >
      const fragments = property.rich_text as Array<Record<string, unknown>>
      return fragments.map((item) => item.plain_text).join("") === key
    })
  }

  dataSources: NotionClientLike["dataSources"] = {
    retrieve: async ({ data_source_id }) => {
      assert.equal(data_source_id, TICKETS_DATA_SOURCE_ID)
      return ticketSchemaResponse()
    },
    query: async (args) => {
      this.queryCalls.push(clone(args))
      const matches = this.matchingTickets(args.filter.rich_text.equals)
      const visible = this.queryView
        ? this.queryView(this.queryCalls.length, clone(matches))
        : matches
      return {
        object: "list",
        type: "page_or_data_source",
        page_or_data_source: {},
        results: clone(visible),
        has_more: false,
        next_cursor: null,
        request_status: { type: "complete" },
      }
    },
  }

  pages: NotionClientLike["pages"] = {
    retrieve: async ({ page_id }) => {
      if (page_id.replaceAll("-", "") === SOURCE_PAGE_ID.replaceAll("-", "")) {
        return sourcePage()
      }
      const page = this.tickets.get(page_id)
      if (!page) throw Object.assign(new Error("not found"), { status: 404 })
      if (this.ticketRetrieveFailures > 0) {
        this.ticketRetrieveFailures -= 1
        throw Object.assign(new Error("readback unavailable"), { status: 503 })
      }
      return clone(page)
    },
    create: async (args) => {
      this.createCalls.push(clone(args))
      const source = args.properties.source as Record<string, unknown>
      const key = requestRichText(source.rich_text)
      const page = ticketPage(FIRST_TICKET_PAGE_ID, key)
      if (!this.createError || this.persistBeforeCreateError) {
        this.tickets.set(FIRST_TICKET_PAGE_ID, page)
      }
      if (this.createError) throw this.createError
      return clone(page)
    },
  }
}

interface MutationFailure {
  error: WorkflowError
  apply: boolean
}

class FakeIntercom {
  snapshot: ConversationSnapshot
  conversationReads = 0
  addTagCalls = 0
  routeCalls = 0
  noteCalls = 0
  readonly noteBodies: string[] = []
  tagFailure: MutationFailure | null = null
  routeFailure: MutationFailure | null = null
  noteFailure: MutationFailure | null = null
  onConversationRead?: (call: number, intercom: FakeIntercom) => void

  constructor(snapshot: ConversationSnapshot = baseConversation()) {
    this.snapshot = clone(snapshot)
  }

  async getIdentity(): Promise<{ adminId: string; workspaceId: string }> {
    return {
      adminId: config.intercomAdminId,
      workspaceId: config.intercomWorkspaceId,
    }
  }

  async getTeam(teamId: string): Promise<{ id: string; name: string }> {
    assert.equal(teamId, TARGET_TEAM_ID)
    return { id: teamId, name: "Engineering" }
  }

  async getTag(tagId: string): Promise<{ id: string; name: string }> {
    assert.equal(tagId, TARGET_TAG_ID)
    return { id: tagId, name: "Escalated to engineering" }
  }

  async getConversation(conversationId: string): Promise<ConversationSnapshot> {
    assert.equal(conversationId, CONVERSATION_ID)
    this.conversationReads += 1
    this.onConversationRead?.(this.conversationReads, this)
    return clone(this.snapshot)
  }

  async getContact(contactId: string): Promise<{ id: string; name: string }> {
    assert.equal(contactId, "contact-123")
    return { id: contactId, name: "Ada Lovelace" }
  }

  async getCompany(companyId: string): Promise<{ id: string; name: string }> {
    assert.equal(companyId, "company-123")
    return { id: companyId, name: "Analytical Engines" }
  }

  private applyTag(): void {
    if (!this.snapshot.tags.some((tag) => tag.id === TARGET_TAG_ID)) {
      this.snapshot.tags.push({
        id: TARGET_TAG_ID,
        name: "Escalated to engineering",
      })
    }
    this.snapshot.updatedAt += 1
  }

  async addTag(conversationId: string, tagId: string): Promise<void> {
    assert.equal(conversationId, CONVERSATION_ID)
    assert.equal(tagId, TARGET_TAG_ID)
    this.addTagCalls += 1
    if (!this.tagFailure || this.tagFailure.apply) this.applyTag()
    if (this.tagFailure) throw this.tagFailure.error
  }

  private applyRoute(): void {
    this.snapshot.teamAssigneeId = TARGET_TEAM_ID
    this.snapshot.updatedAt += 1
  }

  async routeToTeam(conversationId: string, teamId: string): Promise<void> {
    assert.equal(conversationId, CONVERSATION_ID)
    assert.equal(teamId, TARGET_TEAM_ID)
    this.routeCalls += 1
    if (!this.routeFailure || this.routeFailure.apply) this.applyRoute()
    if (this.routeFailure) throw this.routeFailure.error
  }

  private applyNote(body: string): void {
    this.snapshot.internalNoteDigests.push({
      partId: `note-${this.noteCalls}`,
      digest: intercomNoteDigest(body),
    })
    this.snapshot.updatedAt += 1
  }

  async addInternalNote(conversationId: string, body: string): Promise<void> {
    assert.equal(conversationId, CONVERSATION_ID)
    this.noteCalls += 1
    this.noteBodies.push(body)
    if (!this.noteFailure || this.noteFailure.apply) this.applyNote(body)
    if (this.noteFailure) throw this.noteFailure.error
  }
}

function harness(snapshot = baseConversation()): {
  notion: FakeNotion
  intercom: FakeIntercom
  dependencies: WorkflowDependencies
} {
  const notion = new FakeNotion()
  const intercom = new FakeIntercom(snapshot)
  return {
    notion,
    intercom,
    dependencies: { notion, intercom },
  }
}

function inputFor(
  intercom: FakeIntercom,
  draft: TicketDraft | null = ticketDraft,
  expectedTicketPageId: string | null = draft === null
    ? FIRST_TICKET_PAGE_ID
    : null
): CreateTicketInput {
  return {
    conversationId: CONVERSATION_ID,
    inspectionVersion: conversationInspectionVersion(
      intercom.snapshot,
      config,
      expectedTicketPageId
    ),
    ticketDraft: draft,
  }
}

function addConfiguredTag(snapshot: ConversationSnapshot): void {
  if (!snapshot.tags.some((tag) => tag.id === TARGET_TAG_ID)) {
    snapshot.tags.push({
      id: TARGET_TAG_ID,
      name: "Escalated to engineering",
    })
  }
}

function makeRouteComplete(
  snapshot: ConversationSnapshot,
  pageId = FIRST_TICKET_PAGE_ID
): void {
  addConfiguredTag(snapshot)
  snapshot.teamAssigneeId = TARGET_TEAM_ID
  snapshot.internalNoteDigests = [
    {
      partId: "existing-note",
      digest: intercomNoteDigest(ticketNoteBody(SOURCE_KEY, pageId)),
    },
  ]
}

function writeCounts(intercom: FakeIntercom): [number, number, number] {
  return [intercom.addTagCalls, intercom.routeCalls, intercom.noteCalls]
}

function lostMutation(message: string): WorkflowError {
  return new WorkflowError(
    "MUTATION_OUTCOME_UNKNOWN",
    message,
    "ambiguous",
    false,
    true
  )
}

test("inspection canonicalizes IDs, Inbox URLs, and synced pages into one inspection version", async () => {
  const environment = harness()
  const inboxUrl =
    "https://app.intercom.com/a/inbox/workspace-123/inbox/shared/all/conversation/conversation_123"

  const raw = await inspectIntercomConversation(
    { conversationPageId: null, conversationId: "conversation_123" },
    config,
    environment.dependencies
  )
  const url = await inspectIntercomConversation(
    { conversationPageId: null, conversationId: inboxUrl },
    config,
    environment.dependencies
  )
  const page = await inspectIntercomConversation(
    { conversationPageId: SOURCE_PAGE_ID, conversationId: null },
    config,
    environment.dependencies
  )

  assert.equal(raw.conversationId, CONVERSATION_ID)
  assert.equal(url.conversationId, CONVERSATION_ID)
  assert.equal(page.conversationId, CONVERSATION_ID)
  assert.match(raw.inspectionVersion, /^iv1_[0-9a-f]{64}$/)
  assert.equal(url.inspectionVersion, raw.inspectionVersion)
  assert.equal(page.inspectionVersion, raw.inspectionVersion)
  assert.equal(page.sourcePageId, SOURCE_PAGE_ID)
  assert.equal(raw.ticketCreationState, "none")
  assertToolOutput(0, raw)

  environment.intercom.snapshot.updatedAt += 1
  const changed = await inspectIntercomConversation(
    { conversationPageId: null, conversationId: CONVERSATION_ID },
    config,
    environment.dependencies
  )
  assert.notEqual(changed.inspectionVersion, raw.inspectionVersion)
})

test("a reviewed new ticket performs the complete compound action", async () => {
  const environment = harness()
  const inspected = await inspectIntercomConversation(
    { conversationPageId: null, conversationId: CONVERSATION_ID },
    config,
    environment.dependencies
  )

  const result = await createNotionTicket(
    {
      conversationId: inspected.conversationId,
      inspectionVersion: inspected.inspectionVersion,
      ticketDraft,
    },
    config,
    environment.dependencies
  )

  assert.equal(result.ok, true)
  assert.equal(result.status, "completed")
  assert.equal(result.changed, true)
  assert.equal(result.ticket.action, "created")
  assert.equal(result.ticket.pageId, FIRST_TICKET_PAGE_ID)
  assert.deepEqual(result.intercom, {
    tag: "applied",
    route: "applied",
    note: "applied",
  })
  assert.equal(result.customerVisibleReplySent, false)
  assert.equal(result.retryable, false)
  assert.equal(environment.notion.createCalls.length, 1)
  assert.deepEqual(writeCounts(environment.intercom), [1, 1, 1])
  assertToolOutput(1, result)
  assert.equal(
    environment.intercom.noteBodies[0],
    ticketNoteBody(SOURCE_KEY, FIRST_TICKET_PAGE_ID)
  )
})

test("an existing completed ticket is a true no-op with ticketDraft null", async () => {
  const environment = harness()
  environment.notion.seedTicket()
  makeRouteComplete(environment.intercom.snapshot)

  const result = await createNotionTicket(
    inputFor(environment.intercom, null),
    config,
    environment.dependencies
  )

  assert.equal(result.ok, true)
  assert.equal(result.status, "no_op")
  assert.equal(result.changed, false)
  assert.equal(result.ticket.action, "existing")
  assert.deepEqual(result.intercom, {
    tag: "unchanged",
    route: "unchanged",
    note: "unchanged",
  })
  assert.equal(environment.notion.createCalls.length, 0)
  assert.deepEqual(writeCounts(environment.intercom), [0, 0, 0])
})

test("an existing ticket can repair its route with ticketDraft null without overwriting the page", async () => {
  const environment = harness()
  environment.notion.seedTicket()

  const result = await createNotionTicket(
    inputFor(environment.intercom, null),
    config,
    environment.dependencies
  )

  assert.equal(result.ok, true)
  assert.equal(result.status, "completed")
  assert.equal(result.changed, true)
  assert.equal(result.ticket.action, "existing")
  assert.deepEqual(result.intercom, {
    tag: "applied",
    route: "applied",
    note: "applied",
  })
  assert.equal(environment.notion.createCalls.length, 0)
  assert.deepEqual(writeCounts(environment.intercom), [1, 1, 1])
})

test("ticketDraft null cannot create a missing ticket", async () => {
  const environment = harness()

  const result = await createNotionTicket(
    inputFor(environment.intercom, null, null),
    config,
    environment.dependencies
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, "blocked")
  assert.equal(result.changed, false)
  assert.equal(environment.notion.createCalls.length, 0)
  assert.deepEqual(writeCounts(environment.intercom), [0, 0, 0])
})

test("a stale inspection stops before any write", async () => {
  const environment = harness()
  const input = inputFor(environment.intercom)
  environment.intercom.snapshot.title = "The conversation changed"
  environment.intercom.snapshot.updatedAt += 1

  const result = await createNotionTicket(
    input,
    config,
    environment.dependencies
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, "conflict")
  assert.equal(result.changed, false)
  assert.equal(result.ticket.action, "none")
  assert.equal(result.retryable, false)
  assert.equal(environment.notion.queryCalls.length, 1)
  assert.equal(environment.notion.createCalls.length, 0)
  assert.deepEqual(writeCounts(environment.intercom), [0, 0, 0])
})

test("a ticket that appears after inspection is never silently adopted", async () => {
  const environment = harness()
  const inspected = await inspectIntercomConversation(
    { conversationPageId: null, conversationId: CONVERSATION_ID },
    config,
    environment.dependencies
  )
  environment.notion.seedTicket()

  const result = await createNotionTicket(
    {
      conversationId: inspected.conversationId,
      inspectionVersion: inspected.inspectionVersion,
      ticketDraft,
    },
    config,
    environment.dependencies
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, "conflict")
  assert.equal(result.changed, false)
  assert.equal(environment.notion.createCalls.length, 0)
  assert.deepEqual(writeCounts(environment.intercom), [0, 0, 0])
})

test("a conversation change during context lookup stops before Notion creation", async () => {
  const environment = harness()
  const input = inputFor(environment.intercom)
  environment.intercom.onConversationRead = (call, intercom) => {
    if (call === 2) {
      intercom.snapshot.title = "A human clarified the problem"
      intercom.snapshot.updatedAt += 1
    }
  }

  const result = await createNotionTicket(
    input,
    config,
    environment.dependencies
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, "conflict")
  assert.equal(result.changed, false)
  assert.equal(environment.notion.createCalls.length, 0)
  assert.deepEqual(writeCounts(environment.intercom), [0, 0, 0])
})

test("the second live check catches a change after Notion creation before Intercom writes", async () => {
  const environment = harness()
  const input = inputFor(environment.intercom)
  environment.intercom.onConversationRead = (call, intercom) => {
    if (call === 3) {
      intercom.snapshot.title = "A human added important context"
      intercom.snapshot.updatedAt += 1
    }
  }

  const result = await createNotionTicket(
    input,
    config,
    environment.dependencies
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, "conflict")
  assert.equal(result.changed, true)
  assert.equal(result.ticket.action, "created")
  assert.equal(result.ticket.pageId, FIRST_TICKET_PAGE_ID)
  assert.equal(environment.notion.createCalls.length, 1)
  assert.deepEqual(writeCounts(environment.intercom), [0, 0, 0])
})

test("the second live check does not silently restore a tag removed during Notion creation", async () => {
  const environment = harness()
  addConfiguredTag(environment.intercom.snapshot)
  const input = inputFor(environment.intercom)
  environment.intercom.onConversationRead = (call, intercom) => {
    if (call === 3) {
      intercom.snapshot.tags = intercom.snapshot.tags.filter(
        (tag) => tag.id !== TARGET_TAG_ID
      )
      intercom.snapshot.updatedAt += 1
    }
  }

  const result = await createNotionTicket(
    input,
    config,
    environment.dependencies
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, "conflict")
  assert.equal(result.changed, true)
  assert.equal(result.ticket.action, "created")
  assert.deepEqual(writeCounts(environment.intercom), [0, 0, 0])
})

test("duplicate source-key tickets conflict before creation or Intercom writes", async () => {
  const environment = harness()
  environment.notion.seedTicket(FIRST_TICKET_PAGE_ID)
  environment.notion.seedTicket(SECOND_TICKET_PAGE_ID)

  const result = await createNotionTicket(
    inputFor(environment.intercom, null),
    config,
    environment.dependencies
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, "conflict")
  assert.equal(result.changed, false)
  assert.match(result.message, /more than one Notion ticket/i)
  assert.equal(environment.notion.createCalls.length, 0)
  assert.deepEqual(writeCounts(environment.intercom), [0, 0, 0])
})

test("an unknown Notion create reconciles one exact page without issuing a second create", async () => {
  const environment = harness()
  environment.notion.createError = Object.assign(new Error("timed out"), {
    status: 500,
  })
  environment.notion.persistBeforeCreateError = true

  const result = await createNotionTicket(
    inputFor(environment.intercom),
    config,
    environment.dependencies
  )

  assert.equal(result.ok, true)
  assert.equal(result.status, "completed")
  assert.equal(result.changed, true)
  assert.equal(result.ticket.action, "unknown")
  assert.equal(result.ticket.pageId, FIRST_TICKET_PAGE_ID)
  assert.equal(environment.notion.createCalls.length, 1)
  assert.deepEqual(writeCounts(environment.intercom), [1, 1, 1])
})

test("an unknown Notion readback recovers through the confirmed page ID", async () => {
  const environment = harness()
  environment.notion.ticketRetrieveFailures = 1

  const result = await createNotionTicket(
    inputFor(environment.intercom),
    config,
    environment.dependencies
  )

  assert.equal(result.ok, true)
  assert.equal(result.ticket.action, "unknown")
  assert.equal(result.ticket.pageId, FIRST_TICKET_PAGE_ID)
  assert.equal(environment.notion.createCalls.length, 1)
  assert.deepEqual(writeCounts(environment.intercom), [1, 1, 1])
})

test("an unknown Notion create with no visible page is terminal ambiguous", async () => {
  const environment = harness()
  environment.notion.createError = Object.assign(new Error("timed out"), {
    status: 500,
  })

  const result = await createNotionTicket(
    inputFor(environment.intercom),
    config,
    environment.dependencies
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, "ambiguous")
  assert.equal(result.changed, null)
  assert.equal(result.ticket.action, "unknown")
  assert.equal(result.ticket.pageId, null)
  assert.equal(result.retryable, false)
  assert.match(result.nextStep ?? "", /do not issue another create/i)
  assert.equal(environment.notion.createCalls.length, 1)
  assert.deepEqual(writeCounts(environment.intercom), [0, 0, 0])
  assertToolOutput(1, result)
})

test("post-create uniqueness is proven before any Intercom mutation", async () => {
  const environment = harness()
  environment.notion.queryView = (call, matches) =>
    call === 3
      ? [...matches, ticketPage(SECOND_TICKET_PAGE_ID, SOURCE_KEY)]
      : matches

  const result = await createNotionTicket(
    inputFor(environment.intercom),
    config,
    environment.dependencies
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, "conflict")
  assert.equal(result.changed, true)
  assert.equal(result.ticket.action, "unknown")
  assert.equal(environment.notion.createCalls.length, 1)
  assert.deepEqual(writeCounts(environment.intercom), [0, 0, 0])
})

test("a duplicate that becomes visible after Intercom writes is reported as a conflict", async () => {
  const environment = harness()
  environment.notion.queryView = (call, matches) =>
    call === 5
      ? [...matches, ticketPage(SECOND_TICKET_PAGE_ID, SOURCE_KEY)]
      : matches

  const result = await createNotionTicket(
    inputFor(environment.intercom),
    config,
    environment.dependencies
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, "conflict")
  assert.equal(result.changed, true)
  assert.deepEqual(writeCounts(environment.intercom), [1, 1, 1])
})

for (const scenario of ["tag", "route", "note"] as const) {
  test(`an ambiguous ${scenario} with no visible postcondition is terminal`, async () => {
    const environment = harness()
    environment.notion.seedTicket()
    if (scenario !== "tag") addConfiguredTag(environment.intercom.snapshot)
    if (scenario === "note") {
      environment.intercom.snapshot.teamAssigneeId = TARGET_TEAM_ID
    }
    const failure = {
      error: lostMutation(`${scenario} response lost`),
      apply: false,
    }
    if (scenario === "tag") environment.intercom.tagFailure = failure
    if (scenario === "route") environment.intercom.routeFailure = failure
    if (scenario === "note") environment.intercom.noteFailure = failure

    const result = await createNotionTicket(
      inputFor(environment.intercom, null),
      config,
      environment.dependencies
    )

    assert.equal(result.ok, false)
    assert.equal(result.status, "ambiguous")
    assert.equal(result.changed, null)
    assert.equal(result.ticket.action, "existing")
    assert.equal(result.intercom[scenario], "unknown")
    assert.equal(result.retryable, false)
    assert.equal(environment.notion.createCalls.length, 0)
    assert.equal(
      scenario === "tag"
        ? environment.intercom.addTagCalls
        : scenario === "route"
          ? environment.intercom.routeCalls
          : environment.intercom.noteCalls,
      1
    )
  })
}

test("an ambiguous note response can reconcile by its exact visible marker", async () => {
  const environment = harness()
  environment.notion.seedTicket()
  addConfiguredTag(environment.intercom.snapshot)
  environment.intercom.snapshot.teamAssigneeId = TARGET_TEAM_ID
  environment.intercom.noteFailure = {
    error: lostMutation("note response lost"),
    apply: true,
  }

  const result = await createNotionTicket(
    inputFor(environment.intercom, null),
    config,
    environment.dependencies
  )

  assert.equal(result.ok, true)
  assert.equal(result.status, "completed")
  assert.equal(result.changed, null)
  assert.equal(result.intercom.note, "applied")
  assert.equal(result.retryable, false)
  assert.equal(environment.intercom.noteCalls, 1)
})

test("a failed read after a confirmed note is terminal ambiguous", async () => {
  const environment = harness()
  environment.notion.seedTicket()
  addConfiguredTag(environment.intercom.snapshot)
  environment.intercom.snapshot.teamAssigneeId = TARGET_TEAM_ID
  environment.intercom.onConversationRead = (call) => {
    if (call === 3) {
      throw new ProviderError(
        "PROVIDER_UNAVAILABLE",
        "Intercom could not be read.",
        503,
        { retryable: true }
      )
    }
  }

  const result = await createNotionTicket(
    inputFor(environment.intercom, null),
    config,
    environment.dependencies
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, "ambiguous")
  assert.equal(result.changed, true)
  assert.equal(result.intercom.note, "unknown")
  assert.equal(result.retryable, false)
  assert.match(result.nextStep ?? "", /do not post a replacement/i)
  assert.equal(environment.intercom.noteCalls, 1)
})

test("truncated Intercom parts refuse an unverifiable replacement note", async () => {
  const environment = harness()
  environment.notion.seedTicket()
  addConfiguredTag(environment.intercom.snapshot)
  environment.intercom.snapshot.teamAssigneeId = TARGET_TEAM_ID
  environment.intercom.snapshot.partsTruncated = true

  const result = await createNotionTicket(
    inputFor(environment.intercom, null),
    config,
    environment.dependencies
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, "ambiguous")
  assert.equal(result.changed, false)
  assert.equal(result.ticket.action, "existing")
  assert.deepEqual(result.intercom, {
    tag: "pending",
    route: "pending",
    note: "unknown",
  })
  assert.equal(result.retryable, false)
  assert.match(result.nextStep ?? "", /do not post a replacement/i)
  assert.equal(environment.intercom.noteCalls, 0)
})

test("a definitely created ticket may make its first note attempt with truncated history", async () => {
  const environment = harness()
  environment.intercom.snapshot.partsTruncated = true

  const result = await createNotionTicket(
    inputFor(environment.intercom),
    config,
    environment.dependencies
  )

  assert.equal(result.ok, true)
  assert.equal(result.ticket.action, "created")
  assert.equal(result.intercom.note, "applied")
  assert.equal(environment.intercom.noteCalls, 1)
})

test("the internal note marker is deterministic and bound to source plus page ID", () => {
  const dashed = ticketNoteBody(SOURCE_KEY, FIRST_TICKET_PAGE_ID)
  const compact = ticketNoteBody(
    SOURCE_KEY,
    FIRST_TICKET_PAGE_ID.replaceAll("-", "")
  )

  assert.equal(compact, dashed)
  assert.match(dashed, /Reference: icn_[0-9a-f]{32}$/)
  assert.equal(intercomNoteDigest(compact), intercomNoteDigest(dashed))
  assert.notEqual(
    ticketNoteBody(`${SOURCE_KEY}-different`, FIRST_TICKET_PAGE_ID),
    dashed
  )
  assert.notEqual(ticketNoteBody(SOURCE_KEY, SECOND_TICKET_PAGE_ID), dashed)
})

test("a same-invocation human state change stops the remaining compound writes", async () => {
  const environment = harness()
  environment.notion.seedTicket()
  environment.intercom.onConversationRead = (call, intercom) => {
    if (call === 3) {
      intercom.snapshot.teamAssigneeId = "human-selected-team"
      intercom.snapshot.updatedAt += 1
    }
  }

  const result = await createNotionTicket(
    inputFor(environment.intercom, null),
    config,
    environment.dependencies
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, "conflict")
  assert.equal(result.changed, true)
  assert.equal(result.ticket.action, "existing")
  assert.equal(environment.intercom.addTagCalls, 1)
  assert.equal(environment.intercom.routeCalls, 0)
  assert.equal(environment.intercom.noteCalls, 0)
})

test("a definite late failure preserves the created ticket as a partial failure", async () => {
  const environment = harness()
  environment.intercom.noteFailure = {
    error: new ProviderError(
      "HTTP_403",
      "Intercom rejected the internal note.",
      403
    ),
    apply: false,
  }

  const result = await createNotionTicket(
    inputFor(environment.intercom),
    config,
    environment.dependencies
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, "partial_failure")
  assert.equal(result.changed, true)
  assert.equal(result.ticket.action, "created")
  assert.equal(result.ticket.pageId, FIRST_TICKET_PAGE_ID)
  assert.equal(result.retryable, false)
  assert.deepEqual(writeCounts(environment.intercom), [1, 1, 1])
})
