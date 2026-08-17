// Deterministic offline tests for the Intercom sync. No live Intercom or
// Notion connection is made; all HTTP behavior uses mocked responses.

import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { RateLimitError } from "@notionhq/workers"

import {
  COMPANY_SCROLL_RESTART_AFTER_MS,
  companyToChange,
  runCompaniesPage,
} from "./src/companies.js"
import { contactToChange, runContactsPage } from "./src/contacts.js"
import {
  CONSISTENCY_BUFFER_SECONDS,
  WATERMARK_OVERLAP_SECONDS,
  conversationPageContent,
  conversationIncrementalWindow,
  conversationTitle,
  conversationToChange,
  nextConversationWatermark,
  runConversationIncrementalPage,
  runConversationReconciliationPage,
  type ConversationReconciliationState,
} from "./src/conversations.js"
import {
  escapeMarkdown,
  htmlToPlainText,
  optionalUnixSecondsToIso,
  secondsToMinutes,
  unixSecondsToIso,
} from "./src/helpers.js"
import worker, { createCycleCache } from "./src/index.js"
import {
  INTERCOM_API_VERSION,
  INTERCOM_PAGE_SIZE,
  INTERCOM_TICKET_PAGE_SIZE,
  IntercomApiError,
  createIntercomClient,
  getIntercomApiRoot,
  retryAfterSeconds,
  type AssignmentDirectory,
  type ContactDirectory,
  type IntercomClient,
  type IntercomCompany,
  type IntercomContact,
  type IntercomConversation,
  type IntercomPage,
  type IntercomTicket,
} from "./src/intercom.js"
import {
  MAX_CURSOR_HISTORY,
  MAX_CURSOR_PAGES,
  lastAscendingRecordId,
  nextCursorState,
} from "./src/pagination.js"
import {
  TICKET_CONSISTENCY_BUFFER_SECONDS,
  TICKET_WATERMARK_OVERLAP_SECONDS,
  nextTicketWatermark,
  runTicketIncrementalPage,
  runTicketReconciliationPage,
  ticketIncrementalWindow,
  ticketPageContent,
  ticketToChange,
} from "./src/tickets.js"

const originalFetch = globalThis.fetch
const originalToken = process.env.INTERCOM_ACCESS_TOKEN
const originalRegion = process.env.INTERCOM_REGION
const originalDateNow = Date.now

afterEach(() => {
  globalThis.fetch = originalFetch
  Date.now = originalDateNow
  if (originalToken === undefined) delete process.env.INTERCOM_ACCESS_TOKEN
  else process.env.INTERCOM_ACCESS_TOKEN = originalToken
  if (originalRegion === undefined) delete process.env.INTERCOM_REGION
  else process.env.INTERCOM_REGION = originalRegion
})

function propertyText(value: unknown): string {
  return JSON.stringify(value)
}

function assertPropertyContains(value: unknown, expected: string | number) {
  assert.ok(propertyText(value).includes(String(expected)))
}

function assertEmpty(value: unknown) {
  assert.deepEqual(value, [])
}

const contactDirectory: ContactDirectory = {
  admins: new Map([
    ["10", "Ada Lovelace"],
    ["11", "Grace Hopper"],
  ]),
  tags: new Map([
    ["tag-vip", "VIP"],
    ["tag-beta", "Beta"],
  ]),
}

const assignmentDirectory: AssignmentDirectory = {
  admins: new Map([["10", "Ada Lovelace"]]),
  teams: new Map([["20", "Support East"]]),
}

const fullContact: IntercomContact = {
  id: "contact-1",
  external_id: "customer-42",
  workspace_id: "workspace-1",
  role: "user",
  email: "customer@example.com",
  phone: "+1 415 555 0100",
  name: "Pat Customer",
  owner_id: 10,
  has_hard_bounced: true,
  marked_email_as_spam: true,
  unsubscribed_from_emails: true,
  created_at: 1_700_000_000,
  updated_at: 1_700_003_600,
  signed_up_at: 1_699_000_000,
  last_seen_at: 1_700_002_000,
  last_replied_at: 1_700_002_200,
  last_contacted_at: 1_700_002_100,
  tags: {
    data: [
      { id: "tag-vip" },
      { id: "tag-beta", name: "Early access" },
      { id: "tag-vip" },
    ],
    total_count: 3,
  },
  companies: {
    data: [
      { id: "company-acme" },
      { id: "company-globex", name: "Globex International" },
    ],
    total_count: 2,
  },
  location: { country: "Ireland", region: "Leinster", city: "Dublin" },
}

const minimalContact: IntercomContact = {
  id: "contact-minimal",
  external_id: null,
  role: null,
  email: null,
  phone: null,
  name: null,
  owner_id: null,
  has_hard_bounced: false,
  marked_email_as_spam: false,
  unsubscribed_from_emails: false,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_001,
  signed_up_at: 0,
  last_seen_at: null,
  last_replied_at: null,
  last_contacted_at: null,
  tags: null,
  companies: null,
  location: null,
}

const fullCompany: IntercomCompany = {
  id: "company-acme",
  name: "Acme",
  company_id: "acme-external",
  created_at: 1_699_000_000,
  updated_at: 1_700_003_600,
  remote_created_at: 1_698_000_000,
  last_request_at: 1_700_002_000,
  size: 250,
  website: "acme.example",
  industry: "financial_services",
  monthly_spend: 12_500,
  session_count: 4_200,
  user_count: 150,
  plan: { id: "plan-1", name: "Enterprise" },
  tags: { tags: [{ id: "tag-vip", name: "VIP" }] },
  segments: { segments: [{ id: "segment-1", name: "High touch" }] },
}

const minimalCompany: IntercomCompany = {
  id: "company-minimal",
  name: null,
  company_id: null,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_001,
}

const fullConversation: IntercomConversation = {
  id: "conversation-1",
  title: "Billing question",
  created_at: 1_700_000_000,
  updated_at: 1_700_003_600,
  waiting_since: 1_700_003_000,
  snoozed_until: 1_700_007_200,
  state: "open",
  read: false,
  priority: "priority",
  admin_assignee_id: 10,
  team_assignee_id: 20,
  company: { id: "company-acme", name: "Acme" },
  tags: {
    tags: [
      { id: "tag-vip", name: "VIP" },
      { id: "tag-billing", name: "Billing" },
      { id: "tag-vip", name: "VIP" },
    ],
  },
  source: {
    type: "email",
    subject: "Invoice question",
    body: "<p>Hello &amp; thanks.</p><script>hidden()</script><p>Can you <strong>help</strong>?</p>",
    redacted: false,
  },
  contacts: {
    contacts: [{ id: "contact-1" }, { id: "contact-2" }, { id: "contact-1" }],
  },
  conversation_rating: { rating: 2, remark: "Needed *more* detail." },
  sla_applied: { sla_name: "Premium support", sla_status: "missed" },
  statistics: {
    time_to_admin_reply: 90,
    median_time_to_reply: 120,
    handling_time: 600,
    adjusted_handling_time: 540,
    last_contact_reply_at: 1_700_003_200,
    count_reopens: 1,
    count_assignments: 2,
    count_conversation_parts: 8,
  },
  ai_agent: { resolution_state: "confirmed_resolution" },
  ai_agent_participated: true,
}

const minimalConversation: IntercomConversation = {
  id: "conversation-minimal",
  title: null,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_001,
  waiting_since: 0,
  snoozed_until: null,
  state: null,
  read: true,
  priority: "not_priority",
  admin_assignee_id: null,
  team_assignee_id: null,
  company: null,
  tags: null,
  source: null,
  contacts: null,
  conversation_rating: null,
  sla_applied: null,
  statistics: null,
  ai_agent: null,
  ai_agent_participated: false,
}

const fullTicket: IntercomTicket = {
  id: "ticket-api-1",
  ticket_id: "1042",
  category: "Customer",
  created_at: 1_700_000_000,
  updated_at: 1_700_003_600,
  open: true,
  snoozed_until: 1_700_007_200,
  is_shared: true,
  admin_assignee_id: 10,
  team_assignee_id: 20,
  ticket_attributes: {
    _default_title_: "Refund request",
    _default_description_: "<p>Please refund <strong>order 42</strong>.</p>",
    workspace_specific_secret: "not copied",
  },
  ticket_state: {
    id: "state-1",
    category: "waiting_on_customer",
    internal_label: "Waiting for customer",
  },
  ticket_type: { id: "type-1", name: "Refund" },
  contacts: { contacts: [{ id: "contact-1" }, { id: "contact-1" }] },
}

const minimalTicket: IntercomTicket = {
  id: "ticket-api-minimal",
  ticket_id: null,
  category: null,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_001,
  open: false,
  snoozed_until: null,
  is_shared: false,
  admin_assignee_id: "0",
  team_assignee_id: 0,
  ticket_attributes: null,
  ticket_state: null,
  ticket_type: null,
  contacts: null,
}

test("full contact maps actionable fields and company relations", () => {
  const change = contactToChange(fullContact, contactDirectory)
  assert.equal(change.type, "upsert")
  assert.equal(change.key, fullContact.id)
  assert.equal(change.upstreamUpdatedAt, "2023-11-14T23:13:20.000Z")
  assertPropertyContains(change.properties.Name, "Pat Customer")
  assertPropertyContains(change.properties.Role, "User")
  assertPropertyContains(change.properties.Owner, "Ada Lovelace")
  assertPropertyContains(change.properties.Email, "customer@example.com")
  assertPropertyContains(change.properties.Phone, "+1 415 555 0100")
  assertPropertyContains(change.properties.Companies, "company-acme")
  assertPropertyContains(change.properties.Companies, "company-globex")
  assertPropertyContains(change.properties.Tags, "VIP")
  assertPropertyContains(change.properties.Tags, "Early access")
  assertPropertyContains(change.properties.Country, "Ireland")
  assertPropertyContains(
    change.properties["Email Restrictions"],
    "Unsubscribed"
  )
  assertPropertyContains(change.properties["Email Restrictions"], "Marked spam")
  assertPropertyContains(
    change.properties["Email Restrictions"],
    "Hard bounced"
  )
  assertPropertyContains(change.properties["Contact ID"], "contact-1")
  assertPropertyContains(change.properties["External ID"], "customer-42")
})

test("minimal contact uses a stable title and explicitly clears nullable fields", () => {
  const change = contactToChange(minimalContact, contactDirectory)
  assertPropertyContains(change.properties.Name, "Contact contact-minimal")
  for (const property of [
    "Role",
    "Owner",
    "Email",
    "Phone",
    "Companies",
    "Country",
    "Tags",
    "Incomplete Associations",
    "Last Seen",
    "Signed Up",
    "Last Contacted",
    "Last Replied",
    "Email Restrictions",
    "External ID",
  ] as const) {
    assertEmpty(change.properties[property])
  }
})

test("contacts identify association lists that Intercom truncated", () => {
  const both = contactToChange(
    {
      ...fullContact,
      companies: { ...(fullContact.companies ?? {}), has_more: true },
      tags: { ...(fullContact.tags ?? {}), has_more: true },
    },
    contactDirectory
  )
  assertPropertyContains(
    both.properties["Incomplete Associations"],
    "Companies"
  )
  assertPropertyContains(both.properties["Incomplete Associations"], "Tags")

  const tagsOnly = contactToChange(
    {
      ...fullContact,
      companies: { ...(fullContact.companies ?? {}), has_more: false },
      tags: { ...(fullContact.tags ?? {}), has_more: true },
    },
    contactDirectory
  )
  assert.doesNotMatch(
    propertyText(tagsOnly.properties["Incomplete Associations"]),
    /Companies/
  )
  assertPropertyContains(tagsOnly.properties["Incomplete Associations"], "Tags")

  const countMismatch = contactToChange(
    {
      ...minimalContact,
      companies: { data: [{ id: "company-acme" }], total_count: 2 },
    },
    contactDirectory
  )
  assertPropertyContains(
    countMismatch.properties["Incomplete Associations"],
    "Companies"
  )

  const metadataMissing = contactToChange(
    {
      ...minimalContact,
      tags: {
        data: Array.from({ length: 10 }, (_, index) => ({
          id: `tag-${index}`,
        })),
      },
    },
    contactDirectory
  )
  assertPropertyContains(
    metadataMissing.properties["Incomplete Associations"],
    "Tags"
  )
})

test("contact title fallbacks and unknown lookup values stay diagnosable", () => {
  const emailTitle = contactToChange(
    { ...minimalContact, email: "fallback@example.com" },
    contactDirectory
  )
  assertPropertyContains(emailTitle.properties.Name, "fallback@example.com")

  const unknown = contactToChange(
    {
      ...minimalContact,
      owner_id: 404,
      tags: { data: [{ id: "missing-tag" }] },
      companies: { data: [{ id: "missing-company" }] },
    },
    contactDirectory
  )
  assertPropertyContains(unknown.properties.Owner, "Unknown admin (404)")
  assertPropertyContains(unknown.properties.Tags, "Unknown tag (missing-tag)")
  assertPropertyContains(unknown.properties.Companies, "missing-company")
})

test("company transform maps account value and engagement context", () => {
  const change = companyToChange(fullCompany)
  assert.equal(change.key, "company-acme")
  assert.equal(change.upstreamUpdatedAt, "2023-11-14T23:13:20.000Z")
  assertPropertyContains(change.properties.Name, "Acme")
  assertPropertyContains(change.properties.Plan, "Enterprise")
  assertPropertyContains(change.properties.Industry, "Financial Services")
  assertPropertyContains(change.properties.Website, "https://acme.example/")
  assertPropertyContains(change.properties.Employees, 250)
  assertPropertyContains(change.properties.Users, 150)
  assertPropertyContains(change.properties.Sessions, 4200)
  assertPropertyContains(change.properties["Monthly Spend"], 12500)
  assertPropertyContains(change.properties.Tags, "VIP")
  assertPropertyContains(change.properties.Segments, "High touch")
  assertPropertyContains(
    change.properties["External Company ID"],
    "acme-external"
  )
})

test("minimal company has a stable title and clears optional values", () => {
  const change = companyToChange(minimalCompany)
  assertPropertyContains(change.properties.Name, "Company company-minimal")
  for (const property of [
    "Plan",
    "Industry",
    "Website",
    "Employees",
    "Users",
    "Sessions",
    "Monthly Spend",
    "Last Active",
    "Tags",
    "Segments",
    "Created at Source",
    "External Company ID",
  ] as const) {
    assertEmpty(change.properties[property])
  }
})

test("full conversation maps triage, relation, SLA, CSAT, and response fields", () => {
  const change = conversationToChange(fullConversation, assignmentDirectory)
  assert.equal(change.key, fullConversation.id)
  assert.equal(change.upstreamUpdatedAt, "2023-11-14T23:13:20.000Z")
  assertPropertyContains(change.properties.Title, "Billing question")
  assertPropertyContains(change.properties.State, "Open")
  assertPropertyContains(change.properties.Priority, "Yes")
  assertPropertyContains(change.properties.Unread, "Yes")
  assert.equal(
    propertyText(change.properties.Contacts),
    '[{"type":"primaryKey","value":"contact-1"},{"type":"primaryKey","value":"contact-2"}]'
  )
  assertPropertyContains(change.properties.Assignee, "Ada Lovelace")
  assertPropertyContains(change.properties.Team, "Support East")
  assertPropertyContains(change.properties.Channel, "Email")
  assertPropertyContains(change.properties.Tags, "VIP")
  assertPropertyContains(change.properties.Tags, "Billing")
  assertPropertyContains(change.properties["SLA Status"], "Missed")
  assertPropertyContains(change.properties.Rating, 2)
  assertPropertyContains(change.properties.Company, "company-acme")
  assertPropertyContains(change.properties["First Reply (min)"], 1.5)
  assertPropertyContains(change.properties["Median Reply (min)"], 2)
  assertPropertyContains(change.properties["Handling Time (min)"], 9)
  assertPropertyContains(change.properties["Last Contact Reply"], "2023-11")
  assertPropertyContains(change.properties.Reopens, 1)
  assertPropertyContains(change.properties["AI Resolution"], "Confirmed")
  assertPropertyContains(change.properties["Conversation ID"], "conversation-1")
  assert.ok((change.pageContentMarkdown ?? "").includes("Hello & thanks\\."))
  assert.ok(
    (change.pageContentMarkdown ?? "").includes("Needed \\*more\\* detail\\.")
  )
  assert.doesNotMatch(change.pageContentMarkdown ?? "", /<p>|hidden\(\)/)
})

test("minimal conversation clears optional values and preserves false checkboxes", () => {
  const change = conversationToChange(minimalConversation, assignmentDirectory)
  assertPropertyContains(
    change.properties.Title,
    "Conversation conversation-minimal"
  )
  for (const property of [
    "State",
    "Contacts",
    "Assignee",
    "Team",
    "Waiting Since",
    "Channel",
    "Tags",
    "SLA Status",
    "Rating",
    "Company",
    "First Reply (min)",
    "Median Reply (min)",
    "Handling Time (min)",
    "Last Contact Reply",
    "Reopens",
    "AI Resolution",
    "Snoozed Until",
  ] as const) {
    assertEmpty(change.properties[property])
  }
  assertPropertyContains(change.properties.Priority, "No")
  assertPropertyContains(change.properties.Unread, "No")
  assert.equal(change.pageContentMarkdown, "")
})

test("conversation title fallback order skips redacted bodies", () => {
  assert.equal(
    conversationTitle({
      ...minimalConversation,
      source: { subject: "  Subject fallback  ", body: "Body fallback" },
    }),
    "Subject fallback"
  )
  assert.equal(
    conversationTitle({
      ...minimalConversation,
      source: { subject: null, body: "<p>Body fallback</p>" },
    }),
    "Body fallback"
  )
  assert.equal(
    conversationTitle({
      ...minimalConversation,
      source: { body: "Sensitive body", redacted: true },
    }),
    "Conversation conversation-minimal"
  )
  assert.match(
    conversationPageContent({
      ...minimalConversation,
      source: { body: "Sensitive body", redacted: true },
    }),
    /redacted in Intercom/
  )
})

test("unknown conversation assignments are not silently discarded", () => {
  const change = conversationToChange(
    {
      ...minimalConversation,
      admin_assignee_id: 404,
      team_assignee_id: 405,
    },
    assignmentDirectory
  )
  assertPropertyContains(change.properties.Assignee, "Unknown admin (404)")
  assertPropertyContains(change.properties.Team, "Unknown team (405)")

  const unassigned = conversationToChange(
    {
      ...minimalConversation,
      admin_assignee_id: 0,
      team_assignee_id: "0",
    },
    assignmentDirectory
  )
  assertEmpty(unassigned.properties.Assignee)
  assertEmpty(unassigned.properties.Team)
})

test("ticket transform maps workflow context without copying arbitrary attributes", () => {
  const change = ticketToChange(fullTicket, assignmentDirectory)
  assert.equal(change.key, "ticket-api-1")
  assertPropertyContains(change.properties.Title, "Refund request")
  assertPropertyContains(change.properties.State, "Waiting for customer")
  assertPropertyContains(
    change.properties["State Category"],
    "Waiting On Customer"
  )
  assertPropertyContains(change.properties["Ticket Type"], "Refund")
  assertPropertyContains(change.properties.Category, "Customer")
  assertPropertyContains(change.properties.Contacts, "contact-1")
  assertPropertyContains(change.properties.Assignee, "Ada Lovelace")
  assertPropertyContains(change.properties.Team, "Support East")
  assertPropertyContains(change.properties.Open, "Yes")
  assertPropertyContains(change.properties["Shared with Customer"], "Yes")
  assertPropertyContains(change.properties["Inbox Ticket ID"], "1042")
  assertPropertyContains(change.properties["Ticket ID"], "ticket-api-1")
  assert.match(change.pageContentMarkdown ?? "", /Please refund/)
  assert.doesNotMatch(change.pageContentMarkdown ?? "", /workspace_specific/)
})

test("minimal ticket uses API id, clears nullable values, and treats zero as unassigned", () => {
  const change = ticketToChange(minimalTicket, assignmentDirectory)
  assertPropertyContains(change.properties.Title, "Ticket #ticket-api-minimal")
  for (const property of [
    "State",
    "State Category",
    "Ticket Type",
    "Category",
    "Contacts",
    "Assignee",
    "Team",
    "Snoozed Until",
    "Inbox Ticket ID",
  ] as const) {
    assertEmpty(change.properties[property])
  }
  assertPropertyContains(change.properties.Open, "No")
  assertPropertyContains(change.properties["Shared with Customer"], "No")
  assert.equal(ticketPageContent(minimalTicket), "")
})

test("HTML conversion decodes entities, drops hidden content, and bounds output", () => {
  assert.equal(
    htmlToPlainText(
      "<p>Hello&nbsp;world</p><style>.secret{}</style><ul><li>One</li><li>Two &#x1F642;</li></ul>"
    ),
    "Hello world\n• One\n• Two 🙂"
  )
  assert.ok(htmlToPlainText(`<p>${"x".repeat(30_000)}</p>`).length <= 20_000)
  assert.equal(
    htmlToPlainText(`<script>${"secret".repeat(20_000)}</script><p>Safe</p>`),
    "Safe"
  )
  assert.equal(
    escapeMarkdown("# [link](x) *important*"),
    "\\# \\[link\\]\\(x\\) \\*important\\*"
  )
})

test("timestamp and duration helpers validate edge cases", () => {
  assert.equal(unixSecondsToIso(0, "epoch"), "1970-01-01T00:00:00.000Z")
  assert.equal(optionalUnixSecondsToIso(0, "optional"), undefined)
  assert.equal(secondsToMinutes(0), 0)
  assert.equal(secondsToMinutes(61), 1.02)
  assert.equal(secondsToMinutes(-1), undefined)
  assert.throws(() => unixSecondsToIso(-1, "invalid"), /non-negative/)
  assert.throws(() => unixSecondsToIso(1.5, "invalid"), /non-negative/)
  assert.throws(
    () => contactToChange({ ...minimalContact, id: " " }, contactDirectory),
    /contact is missing its id/
  )
  assert.throws(
    () =>
      conversationToChange(
        { ...minimalConversation, id: "" },
        assignmentDirectory
      ),
    /conversation is missing its id/
  )
})

test("incremental windows keep a buffer and advance with overlap", () => {
  const now = () => new Date(1_000_000)
  assert.deepEqual(conversationIncrementalWindow(undefined, now), {
    since: 0,
    until: 1_000 - CONSISTENCY_BUFFER_SECONDS,
  })
  assert.equal(
    nextConversationWatermark(10_000),
    10_000 - WATERMARK_OVERLAP_SECONDS
  )
  assert.equal(nextConversationWatermark(100), 0)
  assert.deepEqual(
    conversationIncrementalWindow(
      {
        since: 500,
        until: 700,
        after: "cursor",
        recentCursors: ["cursor"],
        pageCount: 1,
      },
      () => new Date(2_000_000)
    ),
    { since: 500, until: 700 }
  )
})

test("ticket windows pin pagination and replay an overlap", () => {
  const now = () => new Date(1_000_000)
  assert.deepEqual(ticketIncrementalWindow(undefined, now), {
    since: 0,
    until: 1_000 - TICKET_CONSISTENCY_BUFFER_SECONDS,
  })
  assert.equal(
    nextTicketWatermark(10_000),
    10_000 - TICKET_WATERMARK_OVERLAP_SECONDS
  )
  assert.deepEqual(
    ticketIncrementalWindow(
      {
        since: 500,
        until: 700,
        after: "ticket-cursor",
        recentCursors: ["ticket-cursor"],
        pageCount: 1,
      },
      () => new Date(2_000_000)
    ),
    { since: 500, until: 700 }
  )
})

test("incremental state rejects malformed windows before API calls", () => {
  assert.throws(
    () => conversationIncrementalWindow({ since: 1, after: "cursor" }),
    /missing its pinned until/
  )
  assert.throws(
    () => conversationIncrementalWindow({ since: 1, until: 2 }),
    /until without a pagination cursor/
  )
  assert.throws(
    () => conversationIncrementalWindow({ since: -1 }),
    /non-negative/
  )
  assert.throws(
    () =>
      conversationIncrementalWindow({ since: 10, until: 5, after: "cursor" }),
    /ends before it starts/
  )
})

test("cursor state rejects immediate and longer pagination loops", () => {
  const first = nextCursorState(undefined, "A", "contacts")
  const second = nextCursorState(first, "B", "contacts")
  assert.deepEqual(second, {
    after: "B",
    recentCursors: ["A", "B"],
    pageCount: 2,
  })
  assert.throws(() => nextCursorState(second, "A", "contacts"), /repeated/)
  assert.throws(() => nextCursorState(undefined, "", "contacts"), /missing/)
})

test("cursor state keeps bounded history and enforces a maximum page count", () => {
  let state = nextCursorState(undefined, "cursor-0", "contacts")
  for (let index = 1; index < MAX_CURSOR_HISTORY + 20; index++) {
    state = nextCursorState(state, `cursor-${index}`, "contacts")
  }
  assert.equal(state.recentCursors.length, MAX_CURSOR_HISTORY)
  assert.equal(state.recentCursors[0], "cursor-20")
  assert.equal(state.pageCount, MAX_CURSOR_HISTORY + 20)
  assert.throws(
    () =>
      nextCursorState(
        {
          after: "last",
          recentCursors: ["last"],
          pageCount: MAX_CURSOR_PAGES - 1,
        },
        "one-too-many",
        "contacts"
      ),
    /exceeded 10000 pages/
  )
})

test("search ordering checkpoints immutable IDs across pages", () => {
  assert.equal(
    lastAscendingRecordId(
      ["conversation-1", "conversation-2"],
      undefined,
      "search"
    ),
    "conversation-2"
  )
  assert.equal(
    lastAscendingRecordId(["conversation-3"], "conversation-2", "search"),
    "conversation-3"
  )
  assert.throws(
    () => lastAscendingRecordId(["conversation-2"], "conversation-2", "search"),
    /strictly ascending/
  )
  assert.throws(
    () =>
      lastAscendingRecordId(
        ["conversation-3", "conversation-2"],
        undefined,
        "search"
      ),
    /strictly ascending/
  )
})

type FakeClientCalls = {
  contacts: Array<string | undefined>
  searches: Array<{ since: number; until: number; cursor?: string }>
  conversations: Array<string | undefined>
  companyScrolls?: Array<string | undefined>
  ticketSearches?: Array<{ since: number; until: number; cursor?: string }>
  tickets?: Array<{ createdBefore: number; cursor?: string }>
}

function fakeClient(
  pages: {
    contacts?: Array<IntercomPage<IntercomContact>>
    companies?: Array<{ records: IntercomCompany[]; scrollParameter?: string }>
    searches?: Array<IntercomPage<IntercomConversation>>
    conversations?: Array<IntercomPage<IntercomConversation>>
    ticketSearches?: Array<IntercomPage<IntercomTicket>>
    tickets?: Array<IntercomPage<IntercomTicket>>
  },
  calls: FakeClientCalls
): IntercomClient {
  return {
    async listContacts(cursor) {
      calls.contacts.push(cursor)
      const page = pages.contacts?.shift()
      if (!page) throw new Error("Missing fake contact page")
      return page
    },
    async scrollCompanies(scrollParameter) {
      ;(calls.companyScrolls ??= []).push(scrollParameter)
      const page = pages.companies?.shift()
      if (!page) throw new Error("Missing fake company page")
      return page
    },
    async searchConversations(since, until, cursor) {
      calls.searches.push({ since, until, cursor })
      const page = pages.searches?.shift()
      if (!page) throw new Error("Missing fake search page")
      return page
    },
    async searchTickets(since, until, cursor) {
      ;(calls.ticketSearches ??= []).push({ since, until, cursor })
      const page = pages.ticketSearches?.shift()
      if (!page) throw new Error("Missing fake ticket search page")
      return page
    },
    async searchTicketsForReconciliation(createdBefore, cursor) {
      ;(calls.tickets ??= []).push({ createdBefore, cursor })
      const page = pages.tickets?.shift()
      if (!page) throw new Error("Missing fake ticket page")
      return page
    },
    async listConversations(cursor) {
      calls.conversations.push(cursor)
      const page = pages.conversations?.shift()
      if (!page) throw new Error("Missing fake conversation page")
      return page
    },
    async fetchContactDirectory() {
      return contactDirectory
    },
    async fetchAssignmentDirectory() {
      return assignmentDirectory
    },
  }
}

test("contact replacement follows cursors and ends without continuation state", async () => {
  const calls: FakeClientCalls = {
    contacts: [],
    searches: [],
    conversations: [],
  }
  const client = fakeClient(
    {
      contacts: [
        { records: [fullContact], nextCursor: "contacts-next" },
        { records: [minimalContact] },
      ],
    },
    calls
  )
  const first = await runContactsPage(client, contactDirectory, undefined)
  const second = await runContactsPage(
    client,
    contactDirectory,
    first.nextState
  )
  assert.equal(first.hasMore, true)
  assert.equal(first.nextState.after, "contacts-next")
  assert.deepEqual(calls.contacts, [undefined, "contacts-next"])
  assert.deepEqual(second, {
    changes: [contactToChange(minimalContact, contactDirectory)],
    hasMore: false,
  })
})

test("company replacement accepts a stable scroll token and guards repeated pages", async () => {
  const calls: FakeClientCalls = {
    contacts: [],
    searches: [],
    conversations: [],
  }
  const client = fakeClient(
    {
      companies: [
        { records: [fullCompany], scrollParameter: "scroll-session" },
        { records: [minimalCompany], scrollParameter: "scroll-session" },
        { records: [], scrollParameter: "scroll-session" },
      ],
    },
    calls
  )
  const first = await runCompaniesPage(client, undefined)
  if (!first.hasMore) assert.fail("Expected another company page")
  const second = await runCompaniesPage(client, first.nextState)
  if (!second.hasMore) assert.fail("Expected a company terminal page")
  const terminal = await runCompaniesPage(client, second.nextState)
  assert.equal(first.hasMore, true)
  assert.equal(second.nextState.pageCount, 2)
  assert.deepEqual(calls.companyScrolls, [
    undefined,
    "scroll-session",
    "scroll-session",
  ])
  assert.deepEqual(terminal, { changes: [], hasMore: false })

  const repeated = fakeClient(
    {
      companies: [
        { records: [fullCompany], scrollParameter: "scroll-session" },
      ],
    },
    calls
  )
  await assert.rejects(
    () => runCompaniesPage(repeated, first.nextState),
    /repeated a page/
  )
})

test("company replacement safely restarts an expired scroll session", async () => {
  const calls: Array<string | undefined> = []
  const base = fakeClient({}, { contacts: [], searches: [], conversations: [] })
  const client: IntercomClient = {
    ...base,
    async scrollCompanies(scrollParameter) {
      calls.push(scrollParameter)
      if (calls.length === 1) {
        throw new IntercomApiError(
          500,
          "Request failed due to an internal network error. Please restart the scroll operation."
        )
      }
      return { records: [fullCompany], scrollParameter: "fresh-scroll" }
    },
  }
  const result = await runCompaniesPage(client, {
    scrollParameter: "expired-scroll",
    recentPageKeys: ["old:first:1"],
    pageCount: 4,
    restartCount: 0,
  })
  if (!result.hasMore) assert.fail("Expected restarted company pagination")
  assert.deepEqual(calls, ["expired-scroll", undefined])
  assert.equal(result.nextState.restartCount, 1)
  assert.equal(result.nextState.pageCount, 1)

  let genericAttempts = 0
  const genericFailure: IntercomClient = {
    ...base,
    async scrollCompanies() {
      genericAttempts++
      throw new IntercomApiError(500, "Intercom service unavailable")
    },
  }
  await assert.rejects(
    () =>
      runCompaniesPage(genericFailure, {
        scrollParameter: "active-scroll",
        recentPageKeys: ["old:first:1"],
        pageCount: 1,
      }),
    /service unavailable/
  )
  assert.equal(genericAttempts, 1)
})

test("company replacement respects active scrolls, restarts stale state, and fails closed", async () => {
  const calls: Array<string | undefined> = []
  const base = fakeClient({}, { contacts: [], searches: [], conversations: [] })
  const client: IntercomClient = {
    ...base,
    async scrollCompanies(scrollParameter) {
      calls.push(scrollParameter)
      return { records: [fullCompany], scrollParameter: "fresh-scroll" }
    },
  }
  const staleState = {
    scrollParameter: "expired-scroll",
    recentPageKeys: ["old:first:1"],
    pageCount: 4,
    restartCount: 0,
    lastRequestAt: 1_000,
  }
  const fresh = await runCompaniesPage(
    client,
    staleState,
    () => new Date(1_000 + COMPANY_SCROLL_RESTART_AFTER_MS - 1)
  )
  if (!fresh.hasMore) assert.fail("Expected active company pagination")
  assert.deepEqual(calls, ["expired-scroll"])
  assert.equal(fresh.nextState.restartCount, 0)

  const result = await runCompaniesPage(
    client,
    staleState,
    () => new Date(1_000 + COMPANY_SCROLL_RESTART_AFTER_MS)
  )
  if (!result.hasMore) assert.fail("Expected restarted company pagination")
  assert.deepEqual(calls, ["expired-scroll", undefined])
  assert.equal(result.nextState.restartCount, 1)
  assert.equal(result.nextState.pageCount, 1)

  await assert.rejects(
    () =>
      runCompaniesPage(
        client,
        { ...staleState, restartCount: 2 },
        () => new Date(1_000 + COMPANY_SCROLL_RESTART_AFTER_MS)
      ),
    /repeatedly expired/
  )
  assert.deepEqual(calls, ["expired-scroll", undefined])

  await assert.rejects(
    () =>
      runCompaniesPage(
        client,
        { ...staleState, lastRequestAt: 100_000 },
        () => new Date(99_999)
      ),
    /invalid timestamp/
  )
  assert.deepEqual(calls, ["expired-scroll", undefined])
})

test("conversation incremental pages pin bounds and checkpoint with overlap", async () => {
  const calls: FakeClientCalls = {
    contacts: [],
    searches: [],
    conversations: [],
  }
  const client = fakeClient(
    {
      searches: [
        { records: [fullConversation], nextCursor: "search-next" },
        { records: [minimalConversation] },
      ],
    },
    calls
  )
  const first = await runConversationIncrementalPage(
    client,
    assignmentDirectory,
    undefined,
    () => new Date(2_000_000)
  )
  const second = await runConversationIncrementalPage(
    client,
    assignmentDirectory,
    first.nextState,
    () => new Date(9_000_000)
  )
  assert.deepEqual(calls.searches, [
    { since: 0, until: 1_940, cursor: undefined },
    { since: 0, until: 1_940, cursor: "search-next" },
  ])
  if (!first.hasMore) assert.fail("Expected another conversation page")
  assert.equal(first.nextState.lastRecordId, fullConversation.id)
  assert.equal(second.hasMore, false)
  assert.deepEqual(second.nextState, {
    since: 1_940 - WATERMARK_OVERLAP_SECONDS,
  })

  const outOfOrder = fakeClient(
    {
      searches: [{ records: [minimalConversation, fullConversation] }],
    },
    calls
  )
  await assert.rejects(
    () =>
      runConversationIncrementalPage(
        outOfOrder,
        assignmentDirectory,
        undefined,
        () => new Date(2_000_000)
      ),
    /strictly ascending/
  )

  const emptyPage = fakeClient(
    {
      searches: [{ records: [], nextCursor: "empty-page" }],
    },
    calls
  )
  await assert.rejects(
    () =>
      runConversationIncrementalPage(
        emptyPage,
        assignmentDirectory,
        undefined,
        () => new Date(2_000_000)
      ),
    /cursor without records/
  )
})

test("incremental searches restart legacy cursor state before checking order", async () => {
  const calls: FakeClientCalls = {
    contacts: [],
    searches: [],
    conversations: [],
  }
  const client = fakeClient(
    { searches: [{ records: [minimalConversation] }] },
    calls
  )
  await runConversationIncrementalPage(
    client,
    assignmentDirectory,
    {
      since: 500,
      until: 700,
      after: "legacy-cursor",
      recentCursors: ["legacy-cursor"],
      pageCount: 1,
    },
    () => new Date(1_000_000)
  )
  assert.deepEqual(calls.searches, [
    { since: 500, until: 940, cursor: undefined },
  ])
})

test("conversation replacement pins total count before allowing deletion", async () => {
  const calls: FakeClientCalls = {
    contacts: [],
    searches: [],
    conversations: [],
  }
  const client = fakeClient(
    {
      conversations: [
        {
          records: [fullConversation],
          nextCursor: "reconcile-next",
          totalCount: 1,
        },
        { records: [], totalCount: 1 },
      ],
    },
    calls
  )
  const first = await runConversationReconciliationPage(
    client,
    assignmentDirectory,
    undefined
  )
  const second = await runConversationReconciliationPage(
    client,
    assignmentDirectory,
    first.nextState
  )
  assert.deepEqual(calls.conversations, [undefined, "reconcile-next"])
  if (!first.hasMore) assert.fail("Expected another reconciliation page")
  assert.equal(first.nextState.expectedTotalCount, 1)
  assert.equal(first.nextState.seenCount, 1)
  assert.deepEqual(first.nextState.recentRecordIds, [fullConversation.id])
  assert.deepEqual(second, { changes: [], hasMore: false })

  const changedTotal = fakeClient(
    { conversations: [{ records: [], totalCount: 2 }] },
    calls
  )
  await assert.rejects(
    () =>
      runConversationReconciliationPage(
        changedTotal,
        assignmentDirectory,
        first.nextState
      ),
    /total changed/
  )

  const prematureEnd = fakeClient(
    { conversations: [{ records: [], totalCount: 1 }] },
    calls
  )
  await assert.rejects(
    () =>
      runConversationReconciliationPage(prematureEnd, assignmentDirectory, {
        ...first.nextState,
        seenCount: 0,
        recentRecordIds: [],
      }),
    /before total_count was reached/
  )

  const repeatedRecord = fakeClient(
    { conversations: [{ records: [fullConversation], totalCount: 1 }] },
    calls
  )
  await assert.rejects(
    () =>
      runConversationReconciliationPage(
        repeatedRecord,
        assignmentDirectory,
        first.nextState
      ),
    /repeated a record/
  )

  const emptyPage = fakeClient(
    {
      conversations: [{ records: [], nextCursor: "empty-page", totalCount: 0 }],
    },
    calls
  )
  await assert.rejects(
    () =>
      runConversationReconciliationPage(
        emptyPage,
        assignmentDirectory,
        undefined
      ),
    /cursor without records/
  )
})

test("conversation replacement restarts continuation state without guards", async () => {
  const calls: FakeClientCalls = {
    contacts: [],
    searches: [],
    conversations: [],
  }
  const client = fakeClient(
    {
      conversations: [{ records: [minimalConversation], totalCount: 1 }],
    },
    calls
  )
  const result = await runConversationReconciliationPage(
    client,
    assignmentDirectory,
    {
      after: "legacy-cursor",
      recentCursors: ["legacy-cursor"],
      pageCount: 3,
    } as unknown as ConversationReconciliationState
  )
  assert.deepEqual(calls.conversations, [undefined])
  assert.equal(result.hasMore, false)
})

test("ticket incremental pages pin bounds and checkpoint with overlap", async () => {
  const calls: FakeClientCalls = {
    contacts: [],
    searches: [],
    conversations: [],
  }
  const client = fakeClient(
    {
      ticketSearches: [
        { records: [fullTicket], nextCursor: "ticket-next" },
        { records: [minimalTicket] },
      ],
    },
    calls
  )
  const first = await runTicketIncrementalPage(
    client,
    assignmentDirectory,
    undefined,
    () => new Date(2_000_000)
  )
  const second = await runTicketIncrementalPage(
    client,
    assignmentDirectory,
    first.nextState,
    () => new Date(9_000_000)
  )
  assert.deepEqual(calls.ticketSearches, [
    { since: 0, until: 1_940, cursor: undefined },
    { since: 0, until: 1_940, cursor: "ticket-next" },
  ])
  if (!first.hasMore) assert.fail("Expected another ticket page")
  assert.equal(first.nextState.lastRecordId, fullTicket.id)
  assert.deepEqual(second.nextState, {
    since: 1_940 - TICKET_WATERMARK_OVERLAP_SECONDS,
  })
})

test("ticket replacement pins total count before allowing reconciliation", async () => {
  const calls: FakeClientCalls = {
    contacts: [],
    searches: [],
    conversations: [],
  }
  const client = fakeClient(
    {
      tickets: [
        { records: [fullTicket], nextCursor: "ticket-all-next", totalCount: 2 },
        { records: [minimalTicket], totalCount: 2 },
      ],
    },
    calls
  )
  const first = await runTicketReconciliationPage(
    client,
    assignmentDirectory,
    undefined,
    () => new Date(2_000_000)
  )
  if (!first.hasMore) assert.fail("Expected another ticket page")
  const second = await runTicketReconciliationPage(
    client,
    assignmentDirectory,
    first.nextState
  )
  assert.deepEqual(calls.tickets, [
    { createdBefore: 1_940, cursor: undefined },
    { createdBefore: 1_940, cursor: "ticket-all-next" },
  ])
  assert.equal(first.nextState.createdBefore, 1_940)
  assert.equal(first.nextState.expectedTotalCount, 2)
  assert.equal(first.nextState.lastRecordId, fullTicket.id)
  assert.deepEqual(second.hasMore, false)

  const changedTotal = fakeClient(
    { tickets: [{ records: [], totalCount: 3 }] },
    calls
  )
  await assert.rejects(
    () =>
      runTicketReconciliationPage(
        changedTotal,
        assignmentDirectory,
        first.nextState
      ),
    /total changed/
  )

  const outOfOrder = fakeClient(
    {
      tickets: [{ records: [minimalTicket, fullTicket], totalCount: 2 }],
    },
    calls
  )
  await assert.rejects(
    () =>
      runTicketReconciliationPage(
        outOfOrder,
        assignmentDirectory,
        first.nextState
      ),
    /strictly ascending/
  )
})

test("ticket replacement safely restarts continuation state from older deployments", async () => {
  const calls: FakeClientCalls = {
    contacts: [],
    searches: [],
    conversations: [],
  }
  const client = fakeClient(
    {
      tickets: [{ records: [minimalTicket], totalCount: 1 }],
    },
    calls
  )
  const result = await runTicketReconciliationPage(
    client,
    assignmentDirectory,
    {
      after: "legacy-cursor",
      recentCursors: ["legacy-cursor"],
      pageCount: 3,
      expectedTotalCount: 3,
      seenCount: 2,
      recentRecordIds: ["old-ticket"],
    },
    () => new Date(3_000_000)
  )
  assert.deepEqual(calls.tickets, [{ createdBefore: 2_940, cursor: undefined }])
  assert.deepEqual(result.hasMore, false)
})

test("cycle cache shares pending work, evicts terminal data, and retries errors", async () => {
  const cache = createCycleCache<number>()
  let loads = 0
  const load = async () => {
    loads++
    return 42
  }
  const [first, second] = await Promise.all([cache.get(load), cache.get(load)])
  assert.equal(first, 42)
  assert.equal(second, 42)
  assert.equal(loads, 1)
  cache.clear()
  assert.equal(await cache.get(load), 42)
  assert.equal(loads, 2)

  const failing = createCycleCache<number>()
  let attempts = 0
  await assert.rejects(() =>
    failing.get(async () => {
      attempts++
      throw new Error("temporary")
    })
  )
  assert.equal(
    await failing.get(async () => {
      attempts++
      return 7
    }),
    7
  )
  assert.equal(attempts, 2)
})

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  })
}

test("client uses regional host, auth, version, page size, and safe redirects", async () => {
  process.env.INTERCOM_ACCESS_TOKEN = "secret-token"
  process.env.INTERCOM_REGION = "eu"
  let beforeRequests = 0
  let capturedUrl = ""
  let capturedInit: RequestInit | undefined
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input)
    capturedInit = init
    return jsonResponse({
      data: [minimalContact],
      pages: { next: { starting_after: "next-contact" } },
    })
  }

  const client = createIntercomClient(async () => {
    beforeRequests++
  })
  const page = await client.listContacts("current-contact")
  const url = new URL(capturedUrl)
  const headers = new Headers(capturedInit?.headers)
  assert.equal(url.origin, "https://api.eu.intercom.io")
  assert.equal(url.pathname, "/contacts")
  assert.equal(url.searchParams.get("per_page"), String(INTERCOM_PAGE_SIZE))
  assert.equal(url.searchParams.get("starting_after"), "current-contact")
  assert.equal(headers.get("Authorization"), "Bearer secret-token")
  assert.equal(headers.get("Intercom-Version"), INTERCOM_API_VERSION)
  assert.equal(headers.get("Accept"), "application/json")
  assert.equal(capturedInit?.redirect, "error")
  assert.equal(beforeRequests, 1)
  assert.equal(page.nextCursor, "next-contact")
})

test("conversation listing requires the reconciliation total count", async () => {
  process.env.INTERCOM_ACCESS_TOKEN = "secret-token"
  globalThis.fetch = async () =>
    jsonResponse({
      conversations: [minimalConversation],
      total_count: 1,
      pages: { next: null },
    })

  const client = createIntercomClient(async () => {})
  const page = await client.listConversations()
  assert.equal(page.totalCount, 1)

  globalThis.fetch = async () =>
    jsonResponse({ conversations: [], pages: { next: null } })
  await assert.rejects(() => client.listConversations(), /missing total_count/)
})

test("conversation search sends pinned bounds, immutable sort, and cursor", async () => {
  process.env.INTERCOM_ACCESS_TOKEN = "secret-token"
  delete process.env.INTERCOM_REGION
  let capturedInit: RequestInit | undefined
  globalThis.fetch = async (_input, init) => {
    capturedInit = init
    return jsonResponse({ conversations: [], pages: { next: null } })
  }
  const client = createIntercomClient(async () => {})
  await client.searchConversations(100, 200, "search-cursor")
  assert.equal(capturedInit?.method, "POST")
  assert.equal(
    new Headers(capturedInit?.headers).get("Content-Type"),
    "application/json"
  )
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    query: {
      operator: "AND",
      value: [
        { field: "updated_at", operator: ">", value: 100 },
        { field: "updated_at", operator: "<", value: 200 },
      ],
    },
    pagination: { per_page: 150, starting_after: "search-cursor" },
    sort: { field: "id", order: "ascending" },
  })
})

test("ticket search sends pinned bounds and replacement uses immutable membership", async () => {
  process.env.INTERCOM_ACCESS_TOKEN = "secret-token"
  const requests: Array<{ url: string; body: unknown }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as unknown,
    })
    return jsonResponse({ tickets: [], total_count: 0, pages: { next: null } })
  }
  const client = createIntercomClient(async () => {})
  await client.searchTickets(100, 200, "ticket-cursor")
  await client.searchTicketsForReconciliation(300, "all-ticket-cursor")

  assert.equal(new URL(requests[0].url).pathname, "/tickets/search")
  assert.deepEqual(requests[0].body, {
    query: {
      operator: "AND",
      value: [
        { field: "updated_at", operator: ">", value: 100 },
        { field: "updated_at", operator: "<", value: 200 },
      ],
    },
    pagination: {
      per_page: INTERCOM_TICKET_PAGE_SIZE,
      starting_after: "ticket-cursor",
    },
    sort: { field: "id", order: "ascending" },
  })
  assert.deepEqual(requests[1].body, {
    query: {
      operator: "AND",
      value: [
        { field: "created_at", operator: ">", value: 0 },
        { field: "created_at", operator: "<", value: 300 },
      ],
    },
    pagination: {
      per_page: INTERCOM_TICKET_PAGE_SIZE,
      starting_after: "all-ticket-cursor",
    },
    sort: { field: "id", order: "ascending" },
  })
})

test("client resolves contact and assignment directories without starting a company scroll", async () => {
  process.env.INTERCOM_ACCESS_TOKEN = "secret-token"
  const paths: string[] = []
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    paths.push(`${url.pathname}${url.search}`)
    if (url.pathname === "/admins") {
      return jsonResponse({ admins: [{ id: "10", name: "Ada" }] })
    }
    if (url.pathname === "/teams") {
      return jsonResponse({ teams: [{ id: "20", name: "Support" }] })
    }
    if (url.pathname === "/tags") {
      return jsonResponse({ data: [{ id: "tag-1", name: "VIP" }] })
    }
    throw new Error(`Unexpected path ${url.pathname}`)
  }

  const client = createIntercomClient(async () => {})
  const [contacts, assignments] = await Promise.all([
    client.fetchContactDirectory(),
    client.fetchAssignmentDirectory(),
  ])
  assert.equal(contacts.admins.get("10"), "Ada")
  assert.equal(contacts.tags.get("tag-1"), "VIP")
  assert.equal(assignments.admins.get("10"), "Ada")
  assert.equal(assignments.teams.get("20"), "Support")
  assert.ok(!paths.some((path) => path.startsWith("/companies/scroll")))
})

test("company client exposes one scroll page and requires a continuation token", async () => {
  process.env.INTERCOM_ACCESS_TOKEN = "secret-token"
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname
    if (path === "/companies/scroll") {
      return jsonResponse({
        data: [{ id: "company-1", name: "Acme" }],
        scroll_param: "same-scroll",
      })
    }
    throw new Error(`Unexpected path ${path}`)
  }
  const client = createIntercomClient(async () => {})
  const page = await client.scrollCompanies()
  assert.equal(page.records[0]?.id, "company-1")
  assert.equal(page.scrollParameter, "same-scroll")

  globalThis.fetch = async () =>
    jsonResponse({ data: [{ id: "company-without-token" }] })
  await assert.rejects(() => client.scrollCompanies(), /missing its next/)
})

test("client translates rate limits using the longest provider reset", async () => {
  process.env.INTERCOM_ACCESS_TOKEN = "secret-token"
  Date.now = () => 1_000_000
  globalThis.fetch = async () =>
    new Response("", {
      status: 429,
      headers: { "Retry-After": "7", "X-RateLimit-Reset": "1020" },
    })
  const client = createIntercomClient(async () => {})
  await assert.rejects(
    () => client.listContacts(),
    (error: unknown) =>
      error instanceof RateLimitError && error.retryAfter === 20
  )
  assert.equal(retryAfterSeconds(new Response("", { status: 429 })), 10)
})

test("client rejects malformed pagination, JSON, and bounded API errors", async () => {
  process.env.INTERCOM_ACCESS_TOKEN = "secret-token"
  const client = createIntercomClient(async () => {})

  globalThis.fetch = async () => jsonResponse({ data: [], pages: { next: {} } })
  await assert.rejects(() => client.listContacts(), /missing starting_after/)

  globalThis.fetch = async () => new Response("not-json")
  await assert.rejects(() => client.listContacts(), /invalid JSON/)

  globalThis.fetch = async () =>
    new Response("x".repeat(2_000), { status: 500 })
  await assert.rejects(
    () => client.listContacts(),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("Intercom API error (500)") &&
      error.message.length < 650
  )
})

test("configuration allows only official regional hosts and requires a token", async () => {
  delete process.env.INTERCOM_REGION
  assert.equal(getIntercomApiRoot(), "https://api.intercom.io")
  process.env.INTERCOM_REGION = "au"
  assert.equal(getIntercomApiRoot(), "https://api.au.intercom.io")
  process.env.INTERCOM_REGION = "custom"
  assert.throws(() => createIntercomClient(async () => {}), /us, eu, au/)

  delete process.env.INTERCOM_REGION
  delete process.env.INTERCOM_ACCESS_TOKEN
  const client = createIntercomClient(async () => {})
  await assert.rejects(
    () => client.listContacts(),
    /INTERCOM_ACCESS_TOKEN is not set/
  )
})

test("worker manifest exposes one connected four-database support bundle", () => {
  assert.deepEqual(
    worker.manifest.databases.map((database) => [
      database.key,
      database.config.primaryKeyProperty,
    ]),
    [
      ["companies", "Company ID"],
      ["contacts", "Contact ID"],
      ["conversations", "Conversation ID"],
      ["tickets", "Ticket ID"],
    ]
  )
  const syncs = worker.manifest.capabilities.filter(
    (capability) => capability._tag === "sync"
  )
  type SyncManifestConfig = {
    mode?: string
    schedule?: { type: string; intervalMs?: number }
  }
  const config = (key: string) =>
    syncs.find((capability) => capability.key === key)?.config as
      | SyncManifestConfig
      | undefined
  assert.deepEqual(
    [
      config("contactsSync")?.mode,
      config("contactsSync")?.schedule,
      config("companiesSync")?.mode,
      config("companiesSync")?.schedule,
      config("conversationsSync")?.mode,
      config("conversationsSync")?.schedule,
      config("conversationsReconciliation")?.mode,
      config("conversationsReconciliation")?.schedule,
      config("ticketsSync")?.mode,
      config("ticketsSync")?.schedule,
      config("ticketsReconciliation")?.mode,
      config("ticketsReconciliation")?.schedule,
    ],
    [
      "replace",
      { type: "interval", intervalMs: 60 * 60_000 },
      "replace",
      { type: "interval", intervalMs: 60 * 60_000 },
      "incremental",
      { type: "interval", intervalMs: 5 * 60_000 },
      "replace",
      { type: "interval", intervalMs: 24 * 60 * 60_000 },
      "incremental",
      { type: "interval", intervalMs: 5 * 60_000 },
      "replace",
      { type: "interval", intervalMs: 24 * 60 * 60_000 },
    ]
  )
  assert.deepEqual(worker.manifest.pacers, [
    {
      key: "intercom",
      config: { allowedRequests: 1_000, intervalMs: 10_000 },
    },
  ])
  const database = (key: string) =>
    worker.manifest.databases.find((candidate) => candidate.key === key)?.config
      .schema.properties
  const assertRelation = (
    databaseKey: string,
    propertyName: string,
    relatedDatabaseKey: string
  ) => {
    const relation = database(databaseKey)?.[propertyName]
    assert.equal(relation?.type, "relation")
    if (relation?.type !== "relation") assert.fail("Expected relation")
    assert.equal(relation.relatedDatabaseKey, relatedDatabaseKey)
  }
  assertRelation("contacts", "Companies", "companies")
  assertRelation("conversations", "Contacts", "contacts")
  assertRelation("conversations", "Company", "companies")
  assertRelation("tickets", "Contacts", "contacts")
})
