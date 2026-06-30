// Offline tests for the zendesk-sync worker.
// No Zendesk connection is made — all assertions run against pure functions.
// Run: npm test  (or: npx tsx test.ts)

import { RateLimitError } from "@notionhq/workers"
import worker from "./src/index.js"
import { ticketToChange, ticketUrl } from "./src/tickets.js"
import { formatLabel, dateOnly } from "./src/formatters.js"
import { userToChange } from "./src/users.js"
import { ticketMetricToChange } from "./src/ticket-metrics.js"
import { slaPolicyToChange } from "./src/sla-policies.js"
import { surveyResponseToChange } from "./src/survey-responses.js"
import {
  fetchPage,
  fetchSlaPoliciesPage,
  fetchSurveyResponsesPage,
  fetchTicketMetricsPage,
  fetchTicketsPage,
  getAuthorizationHeader,
  isDeletedTicket,
} from "./src/zendesk.js"
import type {
  ZendeskFullUser,
  ZendeskTicket,
  ZendeskTicketMetric,
  ZendeskSlaPolicy,
  ZendeskSurveyResponse,
  UserLookup,
  GroupLookup,
  OrgLookup,
} from "./src/zendesk.js"

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

const orgs: OrgLookup = new Map([[500, { id: 500, name: "Acme Corp" }]])

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
ok(
  "Type is formatted",
  JSON.stringify(change.properties.Type).includes("Problem")
)
ok(
  "Status is formatted",
  JSON.stringify(change.properties.Status).includes("Open")
)
ok(
  "Priority is formatted",
  JSON.stringify(change.properties.Priority).includes("High")
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
  via: { channel: "web" },
  created_at: "2024-01-01",
  updated_at: "2024-01-01",
}

const minimalChange = ticketToChange(
  minimalTicket,
  SUBDOMAIN,
  users,
  groups,
  orgs
)

ok("key is ticket id", minimalChange.key === "99")
ok("null type omits Type", minimalChange.properties.Type === undefined)
ok(
  "null priority omits Priority",
  minimalChange.properties.Priority === undefined
)
ok("empty tags omits Tags", minimalChange.properties.Tags === undefined)
ok(
  "null assignee_id omits Assignee",
  minimalChange.properties.Assignee === undefined
)
ok("null group_id omits Group", minimalChange.properties.Group === undefined)
ok(
  "null organization_id omits Organization",
  minimalChange.properties.Organization === undefined
)
ok(
  "requester resolved to name",
  JSON.stringify(minimalChange.properties.Requester).includes("Alice Requester")
)

// ---------------------------------------------------------------------------
// ticketToChange — user ID fallback when not in lookup
// ---------------------------------------------------------------------------

console.log("ticketToChange — unknown user ID falls back to numeric string:")

const emptyUsers: UserLookup = new Map()
const emptyGroups: GroupLookup = new Map()
const emptyOrgs: OrgLookup = new Map()
const fallbackChange = ticketToChange(
  standardTicket,
  SUBDOMAIN,
  emptyUsers,
  emptyGroups,
  emptyOrgs
)

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
// Additional resource transforms and Worker manifest
// ---------------------------------------------------------------------------

console.log("additional resource transforms:")

const endUser: ZendeskFullUser = {
  id: 7001,
  name: "End User",
  email: "end-user@example.com",
  role: "end-user",
  phone: null,
  organization_id: null,
  tags: [],
  suspended: false,
  last_login_at: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
}
const endUserChange = userToChange(endUser)
ok(
  "end-user role matches the seeded schema option",
  JSON.stringify(endUserChange.properties.Role).includes("End-user") &&
    !JSON.stringify(endUserChange.properties.Role).includes("End-User")
)

const partialMetric: ZendeskTicketMetric = {
  id: 8001,
  ticket_id: 42,
}
const partialMetricChange = ticketMetricToChange(partialMetric)
ok(
  "optional ticket metrics do not crash or emit invalid numbers",
  partialMetricChange.properties["First Reply (min)"] === undefined &&
    partialMetricChange.properties["Full Resolution (min)"] === undefined &&
    partialMetricChange.properties.Reopens === undefined
)

const surveyResponse: ZendeskSurveyResponse = {
  id: "01J1WB51MG6HXTYWE6Q0C93RNW",
  responder_id: 4398080151295,
  expires_at: "2024-08-21T12:00:00.000Z",
  subjects: [{ id: "99", type: "ticket", zrn: "zen:ticket:99" }],
  survey: {
    id: "01J58KJ9RAE0D2EK7HRVM7Z8F2",
    version: 3,
    state: "enabled",
  },
  answers: [
    {
      type: "rating_scale",
      rating: 5,
      rating_category: "good",
      question: {
        id: "rating-question",
        type: "rating_scale_numeric",
        sub_type: "customer_satisfaction",
      },
      created_at: "2024-08-14T12:00:00.000Z",
      updated_at: "2024-08-14T12:00:00.000Z",
    },
    {
      type: "open_ended",
      value: "Fast and helpful.",
      question: {
        id: "comment-question",
        type: "open_ended",
        alias: "comment",
      },
      created_at: "2024-08-14T12:01:00.000Z",
      updated_at: "2024-08-14T12:01:00.000Z",
    },
  ],
}
const surveyResponseChange = surveyResponseToChange(surveyResponse)
ok(
  "current CSAT survey response maps rating, feedback, and ticket",
  surveyResponseChange.key === surveyResponse.id &&
    JSON.stringify(surveyResponseChange.properties.Rating).includes("5") &&
    JSON.stringify(surveyResponseChange.properties["Rating category"]).includes(
      "Good"
    ) &&
    JSON.stringify(surveyResponseChange.properties.Feedback).includes(
      "Fast and helpful."
    ) &&
    JSON.stringify(surveyResponseChange.properties["Ticket ID"]).includes("99")
)
ok(
  "survey response uses the latest answer update as its checkpoint",
  surveyResponseChange.upstreamUpdatedAt === "2024-08-14T12:01:00.000Z"
)

const minimalSurveyResponse = surveyResponseToChange({
  id: "01JMINIMAL",
  responder_id: 123,
})
ok(
  "optional survey response fields do not emit invalid values",
  minimalSurveyResponse.properties.Rating === undefined &&
    minimalSurveyResponse.properties.Feedback === undefined &&
    minimalSurveyResponse.upstreamUpdatedAt === undefined
)

const minimalSlaPolicy: ZendeskSlaPolicy = {
  id: 9001,
  title: "Standard SLA",
  description: null,
  policy_metrics: [],
}
const minimalSlaChange = slaPolicyToChange(minimalSlaPolicy)
ok(
  "optional SLA fields do not crash or emit invalid values",
  minimalSlaChange.properties.Position === undefined &&
    minimalSlaChange.properties["Created at"] === undefined &&
    minimalSlaChange.properties["Updated at"] === undefined &&
    minimalSlaChange.upstreamUpdatedAt === undefined
)

console.log("Worker manifest:")

type SyncManifestConfig = {
  mode?: string
  schedule?: { type: string; intervalMs?: number }
}

function syncConfig(key: string): SyncManifestConfig {
  const capability = worker.capabilities.find(
    (candidate) => candidate.key === key
  )
  if (!capability || capability._tag !== "sync") {
    throw new Error(`Missing sync capability: ${key}`)
  }
  return capability.config as SyncManifestConfig
}

const ticketsConfig = syncConfig("ticketsSync")
const metricsConfig = syncConfig("ticketMetricsSync")
const surveyResponsesConfig = syncConfig("surveyResponsesSync")
const slaConfig = syncConfig("slaPoliciesSync")
ok(
  "tickets use a five-minute incremental sync",
  ticketsConfig.mode === "incremental" &&
    ticketsConfig.schedule?.type === "interval" &&
    ticketsConfig.schedule.intervalMs === 5 * 60_000
)
ok("ticket metrics use incremental mode", metricsConfig.mode === "incremental")
ok(
  "current CSAT survey responses replace daily",
  surveyResponsesConfig.mode === "replace" &&
    surveyResponsesConfig.schedule?.type === "interval" &&
    surveyResponsesConfig.schedule.intervalMs === 24 * 60 * 60_000
)
ok(
  "SLA policies refresh daily",
  slaConfig.schedule?.type === "interval" &&
    slaConfig.schedule.intervalMs === 24 * 60 * 60_000
)
ok(
  "incremental exports share a nine-per-minute pacer",
  worker.manifest.pacers.some(
    (pacer) =>
      pacer.key === "zendeskIncrementalExports" &&
      pacer.config.allowedRequests === 9 &&
      pacer.config.intervalMs === 60_000
  )
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

// ---------------------------------------------------------------------------
// Zendesk client — incremental export, SLA pagination, and rate limits
// ---------------------------------------------------------------------------

async function testZendeskClient() {
  console.log("Zendesk client:")

  const originalFetch = globalThis.fetch
  const originalSubdomain = process.env.ZENDESK_SUBDOMAIN
  const originalToken = process.env.ZENDESK_API_TOKEN
  const originalEmail = process.env.ZENDESK_API_USER_EMAIL
  const requestedUrls: URL[] = []
  const authorizationHeaders: (string | null)[] = []

  process.env.ZENDESK_SUBDOMAIN = "acme"
  process.env.ZENDESK_API_TOKEN = "test-token"
  process.env.ZENDESK_API_USER_EMAIL = "agent@example.com"

  globalThis.fetch = async (input, init) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    const url = new URL(rawUrl)
    requestedUrls.push(url)
    authorizationHeaders.push(new Headers(init?.headers).get("Authorization"))

    if (url.pathname === "/api/v2/incremental/tickets/cursor") {
      const include = url.searchParams.get("include")
      if (include === "metric_sets") {
        return Response.json({
          tickets: [{ id: 404, status: "deleted" }],
          metric_sets: [{ id: 8001, ticket_id: 42 }],
          after_cursor: "metric-cursor-2",
          end_of_stream: true,
        })
      }

      if (url.searchParams.get("cursor") === "ticket-cursor-1") {
        return Response.json({
          tickets: [],
          after_cursor: "ticket-cursor-2",
          end_of_stream: true,
        })
      }

      return Response.json({
        tickets: [standardTicket, { id: 404, status: "deleted" }],
        users: [...users.values()],
        groups: [...groups.values()],
        organizations: [...orgs.values()],
        after_cursor: "ticket-cursor-1",
        end_of_stream: false,
      })
    }

    if (url.pathname === "/api/v2/slas/policies") {
      return Response.json({
        sla_policies: [],
        next_page: url.searchParams.has("page")
          ? null
          : "https://acme.zendesk.com/api/v2/slas/policies?page=2",
      })
    }

    if (url.pathname === "/api/v2/guide/survey_responses") {
      const hasCursor = url.searchParams.has("page[after]")
      return Response.json({
        survey_responses: hasCursor ? [] : [surveyResponse],
        meta: {
          has_more: !hasCursor,
          after_cursor: hasCursor ? null : "survey-cursor-1",
        },
      })
    }

    if (url.pathname === "/api/v2/organizations.json") {
      return new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "7" },
      })
    }

    if (url.pathname === "/api/v2/users.json") {
      return new Response("rate limited", { status: 429 })
    }

    return new Response("Unexpected test URL", { status: 500 })
  }

  try {
    const firstTicketsPage = await fetchTicketsPage()
    const finalTicketsPage = await fetchTicketsPage("ticket-cursor-1")
    const metricsPage = await fetchTicketMetricsPage("metric-cursor-1")
    const firstSurveyPage = await fetchSurveyResponsesPage()
    const finalSurveyPage = await fetchSurveyResponsesPage(
      firstSurveyPage.nextCursor
    )
    const firstSlaPage = await fetchSlaPoliciesPage()
    const finalSlaPage = await fetchSlaPoliciesPage(firstSlaPage.nextCursor)
    type SyncRunResult = {
      changes: { type: string; key: string }[]
      hasMore: boolean
      nextUserContext?: { cursor: string }
    }
    const initialTicketRun = (await worker.run(
      "ticketsSync",
      {},
      { concreteOutput: true }
    )) as SyncRunResult
    const finalTicketRun = (await worker.run(
      "ticketsSync",
      { state: { cursor: "ticket-cursor-1" } },
      { concreteOutput: true }
    )) as SyncRunResult
    const metricRun = (await worker.run(
      "ticketMetricsSync",
      { state: { cursor: "metric-cursor-1" } },
      { concreteOutput: true }
    )) as SyncRunResult
    const surveyRun = (await worker.run(
      "surveyResponsesSync",
      {},
      { concreteOutput: true }
    )) as SyncRunResult

    let rateLimitError: unknown
    try {
      await fetchPage("acme", "/api/v2/organizations.json")
    } catch (error) {
      rateLimitError = error
    }
    let rateLimitWithoutHeader: unknown
    try {
      await fetchPage("acme", "/api/v2/users.json")
    } catch (error) {
      rateLimitWithoutHeader = error
    }

    const initialTicketUrl = requestedUrls.find(
      (url) =>
        url.pathname === "/api/v2/incremental/tickets/cursor" &&
        url.searchParams.has("start_time")
    )
    const nextTicketUrl = requestedUrls.find(
      (url) => url.searchParams.get("cursor") === "ticket-cursor-1"
    )
    ok(
      "initial ticket export starts at retained history and includes AI tickets",
      initialTicketUrl?.searchParams.get("start_time") === "1" &&
        !initialTicketUrl.searchParams.has("cursor") &&
        initialTicketUrl.searchParams.get("per_page") === "100" &&
        initialTicketUrl.searchParams.get("support_type_scope") === "all" &&
        initialTicketUrl.searchParams.get("include") ===
          "users,groups,organizations"
    )
    ok(
      "subsequent ticket exports use only the durable cursor",
      nextTicketUrl != null && !nextTicketUrl.searchParams.has("start_time")
    )
    ok(
      "incremental export follows end_of_stream and retains the final cursor",
      firstTicketsPage.hasMore &&
        firstTicketsPage.nextCursor === "ticket-cursor-1" &&
        !finalTicketsPage.hasMore &&
        finalTicketsPage.nextCursor === "ticket-cursor-2"
    )
    ok(
      "minimal deleted tickets are recognized before transformation",
      firstTicketsPage.tickets.some(isDeletedTicket)
    )
    ok(
      "ticket sync emits explicit deletes from minimal deleted records",
      initialTicketRun.changes.some(
        (change) => change.type === "delete" && change.key === "404"
      )
    )
    ok(
      "terminal incremental runs persist their next scheduled cursor",
      !finalTicketRun.hasMore &&
        finalTicketRun.nextUserContext?.cursor === "ticket-cursor-2"
    )
    ok(
      "incremental ticket sideloads still resolve related names",
      firstTicketsPage.users.get(1001)?.name === "Jane Smith" &&
        firstTicketsPage.groups.get(100)?.name === "Billing Support" &&
        firstTicketsPage.orgs.get(500)?.name === "Acme Corp"
    )
    ok(
      "metric export returns sideloaded metrics and ticket deletions",
      metricsPage.metrics[0]?.ticket_id === 42 &&
        metricsPage.deletedTicketIds.join(",") === "404" &&
        metricsPage.nextCursor === "metric-cursor-2"
    )
    ok(
      "metric sync upserts sideloaded metrics and deletes removed tickets",
      metricRun.changes.some(
        (change) => change.type === "upsert" && change.key === "42"
      ) &&
        metricRun.changes.some(
          (change) => change.type === "delete" && change.key === "404"
        )
    )
    const finalSurveyUrl = requestedUrls.find(
      (url) =>
        url.pathname === "/api/v2/guide/survey_responses" &&
        url.searchParams.get("page[after]") === "survey-cursor-1"
    )
    ok(
      "current CSAT survey responses use cursor pagination",
      firstSurveyPage.responses[0]?.id === surveyResponse.id &&
        firstSurveyPage.hasMore &&
        firstSurveyPage.nextCursor === "survey-cursor-1" &&
        !finalSurveyPage.hasMore &&
        finalSurveyUrl?.searchParams.get("page[size]") === "100"
    )
    ok(
      "survey response sync emits current CSAT responses",
      surveyRun.changes.some(
        (change) => change.type === "upsert" && change.key === surveyResponse.id
      )
    )
    ok(
      "SLA policies follow next_page before completing replace mode",
      firstSlaPage.hasMore &&
        firstSlaPage.nextCursor?.endsWith("?page=2") === true &&
        !finalSlaPage.hasMore &&
        finalSlaPage.nextCursor === undefined
    )
    ok(
      "429 responses preserve Retry-After for Workers backoff",
      rateLimitError instanceof RateLimitError &&
        rateLimitError.retryAfter === 7
    )
    ok(
      "429 responses without Retry-After leave the delay unspecified",
      rateLimitWithoutHeader instanceof RateLimitError &&
        rateLimitWithoutHeader.retryAfter === undefined
    )
    ok(
      "every Zendesk request uses Basic authentication",
      authorizationHeaders.every((header) => header?.startsWith("Basic "))
    )
  } finally {
    globalThis.fetch = originalFetch
    if (originalSubdomain === undefined) delete process.env.ZENDESK_SUBDOMAIN
    else process.env.ZENDESK_SUBDOMAIN = originalSubdomain
    if (originalToken === undefined) delete process.env.ZENDESK_API_TOKEN
    else process.env.ZENDESK_API_TOKEN = originalToken
    if (originalEmail === undefined) delete process.env.ZENDESK_API_USER_EMAIL
    else process.env.ZENDESK_API_USER_EMAIL = originalEmail
  }
}

testZendeskClient()
  .catch((error: unknown) => {
    failed++
    console.error("  FAIL Zendesk client tests", error)
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`)
    if (failed > 0) process.exitCode = 1
  })
