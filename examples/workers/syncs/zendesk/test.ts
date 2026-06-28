// Offline tests for the zendesk-sync worker.
// No Zendesk connection is made — all assertions run against pure functions.
// Run: npm test  (or: npx tsx test.ts)

import {
  ticketToChange,
  ticketUrl,
  formatLabel,
  dateOnly,
} from "./src/transform.js"
import { buildTicketsUrl, getAuthorizationHeader } from "./src/zendesk.js"
import type { ZendeskTicket, UserLookup, GroupLookup, OrgLookup } from "./src/zendesk.js"

let passed = 0
let failed = 0

function ok(name: string, cond: boolean) {
  if (cond) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}`)
  }
}

// ---------------------------------------------------------------------------
// ticketToChange — maps a Zendesk ticket to a sync upsert change
// ---------------------------------------------------------------------------

console.log("ticketToChange — standard ticket:")

const SUBDOMAIN = "acme"

const users: UserLookup = new Map([
  [1001, { id: 1001, name: "Jane Smith", email: "jane@acme.com" }],
  [2001, { id: 2001, name: "Bob Customer", email: "bob@example.com" }],
  [3001, { id: 3001, name: "Alice Requester", email: "alice@example.com" }],
])

const groups: GroupLookup = new Map([
  [100, { id: 100, name: "Billing Support" }],
])

const orgs: OrgLookup = new Map([
  [500, { id: 500, name: "Acme Corp" }],
])

const standardTicket: ZendeskTicket = {
  id: 42,
  subject: "Cannot log in to my account",
  description: "I keep getting a 403 error when I try to log in.",
  type: "problem",
  status: "open",
  priority: "high",
  assignee_id: 1001,
  requester_id: 2001,
  group_id: 100,
  organization_id: 500,
  tags: ["account_access", "login"],
  satisfaction_rating: { score: "good" },
  via: { channel: "email" },
  created_at: "2024-06-15T10:30:00Z",
  updated_at: "2024-06-16T14:00:00Z",
}

const change = ticketToChange(standardTicket, SUBDOMAIN, users, groups, orgs)

ok("type is upsert", change.type === "upsert")
ok("key is ticket id as string", change.key === "42")
ok(
  "Subject contains ticket subject",
  JSON.stringify(change.properties.Subject).includes(
    "Cannot log in to my account"
  )
)
ok(
  "Ticket ID contains id",
  JSON.stringify(change.properties["Ticket ID"]).includes("42")
)
ok(
  "Ticket link contains URL",
  JSON.stringify(change.properties["Ticket link"]).includes(
    "https://acme.zendesk.com/agent/tickets/42"
  )
)
ok("Type is formatted", JSON.stringify(change.properties.Type).includes("Problem"))
ok("Status is formatted", JSON.stringify(change.properties.Status).includes("Open"))
ok(
  "Priority is formatted",
  JSON.stringify(change.properties.Priority).includes("High")
)
ok(
  "CSAT maps good to Satisfied",
  JSON.stringify(change.properties["CSAT score"]).includes("Satisfied")
)
ok(
  "Tags contains raw tag values",
  JSON.stringify(change.properties.Tags).includes("account_access")
)
ok(
  "Channel maps email to Email",
  JSON.stringify(change.properties.Channel).includes("Email")
)
ok(
  "Assignee resolved to name",
  JSON.stringify(change.properties.Assignee).includes("Jane Smith")
)
ok(
  "Group resolved to name",
  JSON.stringify(change.properties.Group).includes("Billing Support")
)
ok(
  "Requester resolved to name",
  JSON.stringify(change.properties.Requester).includes("Bob Customer")
)
ok(
  "Organization resolved to name",
  JSON.stringify(change.properties.Organization).includes("Acme Corp")
)
ok(
  "Created at contains date",
  JSON.stringify(change.properties["Created at"]).includes("2024-06-15")
)
ok(
  "Updated at contains date",
  JSON.stringify(change.properties["Updated at"]).includes("2024-06-16")
)
ok(
  "upstreamUpdatedAt is set",
  change.upstreamUpdatedAt === "2024-06-16T14:00:00Z"
)
ok(
  "pageContentMarkdown contains description",
  change.pageContentMarkdown.includes("403 error")
)

// ---------------------------------------------------------------------------
// ticketToChange — ticket with missing optional fields
// ---------------------------------------------------------------------------

console.log("ticketToChange — minimal ticket:")

const minimalTicket: ZendeskTicket = {
  id: 99,
  subject: "Quick question",
  description: "",
  type: null,
  status: "new",
  priority: null,
  assignee_id: null,
  requester_id: 3001,
  group_id: null,
  organization_id: null,
  tags: [],
  satisfaction_rating: null,
  via: { channel: "web" },
  created_at: "2024-01-01",
  updated_at: "2024-01-01",
}

const minimalChange = ticketToChange(minimalTicket, SUBDOMAIN, users, groups, orgs)

ok("key is ticket id", minimalChange.key === "99")
ok("null type omits Type", minimalChange.properties.Type === undefined)
ok("null priority omits Priority", minimalChange.properties.Priority === undefined)
ok(
  "null satisfaction_rating omits CSAT score",
  minimalChange.properties["CSAT score"] === undefined
)
ok("empty tags omits Tags", minimalChange.properties.Tags === undefined)
ok("null assignee_id omits Assignee", minimalChange.properties.Assignee === undefined)
ok("null group_id omits Group", minimalChange.properties.Group === undefined)
ok("null organization_id omits Organization", minimalChange.properties.Organization === undefined)
ok(
  "requester resolved to name",
  JSON.stringify(minimalChange.properties.Requester).includes("Alice Requester")
)

// ---------------------------------------------------------------------------
// ticketToChange — CSAT score mapping
// ---------------------------------------------------------------------------

console.log("ticketToChange — CSAT score mapping:")

function csatChange(score: string) {
  const t: ZendeskTicket = {
    ...standardTicket,
    satisfaction_rating: { score },
  }
  return ticketToChange(t, SUBDOMAIN, users, groups, orgs)
}

ok(
  "good maps to Satisfied",
  JSON.stringify(csatChange("good").properties["CSAT score"]).includes(
    "Satisfied"
  )
)
ok(
  "bad maps to Not satisfied",
  JSON.stringify(csatChange("bad").properties["CSAT score"]).includes(
    "Not satisfied"
  )
)
ok(
  "offered maps to Pending",
  JSON.stringify(csatChange("offered").properties["CSAT score"]).includes(
    "Pending"
  )
)
ok(
  "unoffered is omitted",
  csatChange("unoffered").properties["CSAT score"] === undefined
)

// ---------------------------------------------------------------------------
// ticketToChange — user ID fallback when not in lookup
// ---------------------------------------------------------------------------

console.log("ticketToChange — unknown user ID falls back to numeric string:")

const emptyUsers: UserLookup = new Map()
const emptyGroups: GroupLookup = new Map()
const emptyOrgs: OrgLookup = new Map()
const fallbackChange = ticketToChange(standardTicket, SUBDOMAIN, emptyUsers, emptyGroups, emptyOrgs)

ok(
  "assignee falls back to numeric ID",
  JSON.stringify(fallbackChange.properties.Assignee).includes("1001")
)
ok(
  "requester falls back to numeric ID",
  JSON.stringify(fallbackChange.properties.Requester).includes("2001")
)
ok(
  "group falls back to numeric ID",
  JSON.stringify(fallbackChange.properties.Group).includes("100")
)
ok(
  "unknown org omits Organization",
  fallbackChange.properties.Organization === undefined
)

// ---------------------------------------------------------------------------
// formatLabel — handles underscores and capitalization
// ---------------------------------------------------------------------------

console.log("formatLabel:")

ok("simple word", formatLabel("open") === "Open")
ok("underscore separated", formatLabel("mobile_sdk") === "Mobile Sdk")
ok("single letter", formatLabel("a") === "A")
ok("empty string", formatLabel("") === "")

// ---------------------------------------------------------------------------
// dateOnly — extracts YYYY-MM-DD from various formats
// ---------------------------------------------------------------------------

console.log("dateOnly:")

ok(
  "ISO timestamp returns date part",
  dateOnly("2024-03-15T12:00:00Z") === "2024-03-15"
)
ok("plain date passes through", dateOnly("2024-03-15") === "2024-03-15")
ok("empty string returns empty", dateOnly("") === "")

// ---------------------------------------------------------------------------
// ticketUrl — builds Zendesk agent URL
// ---------------------------------------------------------------------------

console.log("ticketUrl:")

ok(
  "builds correct URL",
  ticketUrl("acme", 42) === "https://acme.zendesk.com/agent/tickets/42"
)

// ---------------------------------------------------------------------------
// buildTicketsUrl — constructs Zendesk API URL with sideloading
// ---------------------------------------------------------------------------

console.log("buildTicketsUrl:")

ok(
  "includes users sideload",
  buildTicketsUrl("acme").includes("include=users")
)

ok(
  "builds URL without cursor",
  buildTicketsUrl("acme") ===
    "https://acme.zendesk.com/api/v2/tickets.json?page%5Bsize%5D=100&include=users"
)

ok(
  "builds URL with cursor",
  buildTicketsUrl("acme", "abc123") ===
    "https://acme.zendesk.com/api/v2/tickets.json?page%5Bsize%5D=100&include=users&page%5Bafter%5D=abc123"
)

// ---------------------------------------------------------------------------
// getAuthorizationHeader — requires env vars
// ---------------------------------------------------------------------------

console.log("getAuthorizationHeader:")

const origToken = process.env.ZENDESK_API_TOKEN
const origEmail = process.env.ZENDESK_API_USER_EMAIL
const origBasic = process.env.ZENDESK_BASIC_AUTH_TOKEN

// Clean up env for isolated tests
delete process.env.ZENDESK_API_TOKEN
delete process.env.ZENDESK_API_USER_EMAIL
delete process.env.ZENDESK_BASIC_AUTH_TOKEN

let threw = false
try {
  getAuthorizationHeader()
} catch {
  threw = true
}
ok("throws when no credentials configured", threw)

process.env.ZENDESK_API_TOKEN = "test-token"
process.env.ZENDESK_API_USER_EMAIL = "agent@example.com"

const header = getAuthorizationHeader()
ok("returns Basic auth header", header.startsWith("Basic "))
ok(
  "encodes email/token:apitoken",
  Buffer.from(header.replace("Basic ", ""), "base64").toString() ===
    "agent@example.com/token:test-token"
)

// Restore env
if (origToken) process.env.ZENDESK_API_TOKEN = origToken
else delete process.env.ZENDESK_API_TOKEN
if (origEmail) process.env.ZENDESK_API_USER_EMAIL = origEmail
else delete process.env.ZENDESK_API_USER_EMAIL
if (origBasic) process.env.ZENDESK_BASIC_AUTH_TOKEN = origBasic
else delete process.env.ZENDESK_BASIC_AUTH_TOKEN

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
