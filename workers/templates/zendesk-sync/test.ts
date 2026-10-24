// Offline tests for the zendesk-sync worker.
// No Zendesk connection is made — all assertions run against pure functions.
// Run: npm test  (or: npx tsx test.ts)

import { RateLimitError } from "@notionhq/workers"
import worker from "./src/index.js"
import { ticketToChange, ticketUrl } from "./src/tickets.js"
import { formatLabel, dateOnly } from "./src/formatters.js"
import { userToChange } from "./src/users.js"
import { organizationToChange } from "./src/organizations.js"
import { ticketMetricToChange } from "./src/ticket-metrics.js"
import { slaPolicyToChange } from "./src/sla-policies.js"
import { surveyResponseToChange } from "./src/survey-responses.js"
import {
  fetchPage,
  fetchSlaPoliciesPage,
  fetchSurveyResponsesPage,
  fetchTicketMetricsPage,
  fetchTicketMetricsReconciliationPage,
  fetchTicketsPage,
  fetchTicketsReconciliationPage,
  getAuthorizationHeader,
  isDeletedTicket,
} from "./src/zendesk.js"
import type {
  ZendeskFullUser,
  ZendeskOrganization,
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

async function captureError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action()
  } catch (error) {
    return error
  }
  return undefined
}

function isEmptyProperty(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0
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

const tailOnlyTicket: ZendeskTicket = {
  ...standardTicket,
  id: 777,
  subject: "Created after the reconciliation search cutoff",
  updated_at: "2024-06-30T00:02:00Z",
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
  "Assignee relation uses the stable user id",
  JSON.stringify(change.properties["Assignee Record"]).includes("1001")
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
  "Requester relation uses the stable user id",
  JSON.stringify(change.properties["Requester Record"]).includes("2001")
)
ok(
  "Organization resolved to name",
  JSON.stringify(change.properties.Organization).includes("Acme Corp")
)
ok(
  "Organization relation uses the stable organization id",
  JSON.stringify(change.properties["Organization Record"]).includes("500")
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
ok("null type clears Type", isEmptyProperty(minimalChange.properties.Type))
ok(
  "null priority clears Priority",
  isEmptyProperty(minimalChange.properties.Priority)
)
ok("empty tags clears Tags", isEmptyProperty(minimalChange.properties.Tags))
ok(
  "null assignee_id clears Assignee and its relation",
  isEmptyProperty(minimalChange.properties.Assignee) &&
    isEmptyProperty(minimalChange.properties["Assignee Record"])
)
ok(
  "null group_id clears Group",
  isEmptyProperty(minimalChange.properties.Group)
)
ok(
  "null organization_id clears Organization and its relation",
  isEmptyProperty(minimalChange.properties.Organization) &&
    isEmptyProperty(minimalChange.properties["Organization Record"])
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
  "unknown org falls back to its id and preserves the stable relation",
  JSON.stringify(fallbackChange.properties.Organization).includes("500") &&
    JSON.stringify(fallbackChange.properties["Organization Record"]).includes(
      "500"
    )
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
ok(
  "missing user fields explicitly clear stale values",
  isEmptyProperty(endUserChange.properties.Email) === false &&
    isEmptyProperty(endUserChange.properties["Organization ID"]) &&
    isEmptyProperty(endUserChange.properties["Organization Record"]) &&
    isEmptyProperty(endUserChange.properties.Phone) &&
    isEmptyProperty(endUserChange.properties.Tags) &&
    isEmptyProperty(endUserChange.properties["Last login"])
)
const organizationUserChange = userToChange({
  ...endUser,
  organization_id: 500,
})
ok(
  "user organization relation uses the stable organization id",
  JSON.stringify(
    organizationUserChange.properties["Organization Record"]
  ).includes("500")
)

const organization: ZendeskOrganization = {
  id: 500,
  name: "Acme Corp",
  domain_names: [],
  details: null,
  notes: null,
  tags: [],
  group_id: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
}
const organizationChange = organizationToChange(organization)
ok(
  "missing organization fields and page content explicitly clear",
  isEmptyProperty(organizationChange.properties.Domains) &&
    isEmptyProperty(organizationChange.properties.Tags) &&
    isEmptyProperty(organizationChange.properties.Details) &&
    organizationChange.pageContentMarkdown === ""
)

const partialMetric: ZendeskTicketMetric = {
  id: 8001,
  ticket_id: 42,
}
const tailOnlyMetric: ZendeskTicketMetric = {
  id: 8002,
  ticket_id: 777,
  updated_at: "2024-06-30T00:02:00Z",
}
const partialMetricChange = ticketMetricToChange(partialMetric)
ok(
  "optional ticket metrics clear stale values and retain their ticket relation",
  isEmptyProperty(partialMetricChange.properties["First Reply (min)"]) &&
    isEmptyProperty(partialMetricChange.properties["Full Resolution (min)"]) &&
    isEmptyProperty(partialMetricChange.properties.Reopens) &&
    JSON.stringify(partialMetricChange.properties["Ticket Record"]).includes(
      "42"
    )
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
    JSON.stringify(surveyResponseChange.properties["Ticket ID"]).includes(
      "99"
    ) &&
    JSON.stringify(surveyResponseChange.properties["Ticket Record"]).includes(
      "99"
    ) &&
    JSON.stringify(
      surveyResponseChange.properties["Responder Record"]
    ).includes("4398080151295")
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
  "optional survey response fields and page content explicitly clear",
  isEmptyProperty(minimalSurveyResponse.properties.Rating) &&
    isEmptyProperty(minimalSurveyResponse.properties.Feedback) &&
    isEmptyProperty(minimalSurveyResponse.properties["Ticket Record"]) &&
    minimalSurveyResponse.pageContentMarkdown === "" &&
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
  "optional SLA fields explicitly clear stale values",
  isEmptyProperty(minimalSlaChange.properties.Position) &&
    isEmptyProperty(minimalSlaChange.properties["Created at"]) &&
    isEmptyProperty(minimalSlaChange.properties["Updated at"]) &&
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

function hasRelation(
  databaseKey: string,
  propertyName: string,
  relatedDatabaseKey: string,
  relatedPropertyName: string
): boolean {
  const database = worker.manifest.databases.find(
    (candidate) => candidate.key === databaseKey
  )
  const property = database?.config.schema.properties[propertyName]
  return (
    property?.type === "relation" &&
    property.relatedDatabaseKey === relatedDatabaseKey &&
    property.config.twoWay &&
    property.config.relatedPropertyName === relatedPropertyName
  )
}

const ticketsConfig = syncConfig("ticketsSync")
const ticketsReconciliationConfig = syncConfig("ticketsReconciliationSync")
const metricsConfig = syncConfig("ticketMetricsSync")
const metricsReconciliationConfig = syncConfig(
  "ticketMetricsReconciliationSync"
)
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
  "tickets and ticket metrics expose manual replacement repair sweeps",
  ticketsReconciliationConfig.mode === "replace" &&
    ticketsReconciliationConfig.schedule?.type === "manual" &&
    metricsReconciliationConfig.mode === "replace" &&
    metricsReconciliationConfig.schedule?.type === "manual"
)
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
ok(
  "independent pacers leave aggregate Zendesk account headroom",
  worker.manifest.pacers.some(
    (pacer) =>
      pacer.key === "zendesk" &&
      pacer.config.allowedRequests === 70 &&
      pacer.config.intervalMs === 60_000
  )
)
ok(
  "manual repair sweeps share a bounded Search Export pacer",
  worker.manifest.pacers.some(
    (pacer) =>
      pacer.key === "zendeskSearchExports" &&
      pacer.config.allowedRequests === 90 &&
      pacer.config.intervalMs === 60_000
  )
)
ok(
  "managed databases expose stable cross-resource relations",
  hasRelation("tickets", "Assignee Record", "users", "Assigned Tickets") &&
    hasRelation("tickets", "Requester Record", "users", "Requested Tickets") &&
    hasRelation("tickets", "Organization Record", "organizations", "Tickets") &&
    hasRelation("users", "Organization Record", "organizations", "Users") &&
    hasRelation(
      "surveyResponses",
      "Ticket Record",
      "tickets",
      "CSAT Responses"
    ) &&
    hasRelation(
      "surveyResponses",
      "Responder Record",
      "users",
      "CSAT Responses"
    ) &&
    hasRelation("ticketMetrics", "Ticket Record", "tickets", "Ticket Metrics")
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
      const startTime = url.searchParams.get("start_time")
      const isReconciliationTail = startTime != null && startTime !== "1"
      if (include === "metric_sets") {
        if (url.searchParams.get("cursor") === "missing-metric-sideload") {
          return Response.json({
            tickets: [],
            after_cursor: "missing-metric-sideload-end",
            end_of_stream: true,
          })
        }
        return Response.json({
          tickets: [
            { id: 404, status: "deleted" },
            ...(isReconciliationTail
              ? [tailOnlyTicket, { id: 42, status: "deleted" as const }]
              : []),
          ],
          metric_sets: [
            partialMetric,
            ...(isReconciliationTail ? [tailOnlyMetric] : []),
          ],
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
        tickets: [
          ...(isReconciliationTail
            ? [tailOnlyTicket, { id: 42, status: "deleted" as const }]
            : [standardTicket]),
          { id: 404, status: "deleted" },
        ],
        users: [...users.values()],
        groups: [...groups.values()],
        organizations: [...orgs.values()],
        after_cursor: "ticket-cursor-1",
        end_of_stream: false,
      })
    }

    if (url.pathname === "/api/v2/search/export") {
      const include = url.searchParams.get("include") ?? ""
      const cursor = url.searchParams.get("page[after]")
      const metrics = include === "tickets(metric_sets)"

      if (cursor === "repeat") {
        return Response.json({
          results: [],
          metric_sets: metrics ? [] : undefined,
          meta: { has_more: true, after_cursor: "repeat" },
        })
      }

      if (cursor === "missing-cursor") {
        return Response.json({
          results: [],
          meta: { has_more: true, after_cursor: null },
        })
      }

      if (cursor === "malformed-page") {
        return Response.json({ results: null, meta: { has_more: "yes" } })
      }

      if (cursor === "empty-continuation") {
        return Response.json({
          results: [],
          users: metrics ? undefined : [],
          groups: metrics ? undefined : [],
          organizations: metrics ? undefined : [],
          metric_sets: metrics ? [] : undefined,
          meta: {
            has_more: true,
            after_cursor: "empty-continuation-next",
          },
        })
      }

      if (cursor) {
        return Response.json({
          results: [],
          users: metrics ? undefined : [],
          groups: metrics ? undefined : [],
          organizations: metrics ? undefined : [],
          metric_sets: metrics ? [] : undefined,
          meta: { has_more: false, after_cursor: null },
        })
      }

      return Response.json({
        results: [{ ...standardTicket, result_type: "ticket" }],
        users: metrics ? undefined : [...users.values()],
        groups: metrics ? undefined : [...groups.values()],
        organizations: metrics ? undefined : [...orgs.values()],
        metric_sets: metrics ? [partialMetric] : undefined,
        meta: {
          has_more: true,
          after_cursor: metrics
            ? "metric-search-cursor"
            : "ticket-search-cursor",
        },
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
    const reconciliationCutoff = "2024-06-30T00:00:00.000Z"
    const emptyTicketReconciliationContinuation =
      await fetchTicketsReconciliationPage(
        reconciliationCutoff,
        "empty-continuation"
      )
    const emptyMetricReconciliationContinuation =
      await fetchTicketMetricsReconciliationPage(
        reconciliationCutoff,
        "empty-continuation"
      )
    const reconciliationTailStart = Math.floor(
      new Date(reconciliationCutoff).getTime() / 1_000
    )
    const firstSurveyPage = await fetchSurveyResponsesPage()
    const finalSurveyPage = await fetchSurveyResponsesPage(
      firstSurveyPage.nextCursor
    )
    const firstSlaPage = await fetchSlaPoliciesPage()
    const finalSlaPage = await fetchSlaPoliciesPage(firstSlaPage.nextCursor)
    type SyncRunResult = {
      changes: { type: string; key: string }[]
      hasMore: boolean
      nextUserContext?: {
        phase?: "search" | "tail"
        cursor?: string
        cutoff?: string
      }
    }
    type TestSyncKey =
      | "ticketsSync"
      | "ticketMetricsSync"
      | "ticketsReconciliationSync"
      | "ticketMetricsReconciliationSync"
      | "surveyResponsesSync"
    const runSync = async (key: TestSyncKey, state?: unknown) =>
      (await worker.run(key, state === undefined ? {} : { state }, {
        concreteOutput: true,
      })) as SyncRunResult

    const initialTicketRun = await runSync("ticketsSync")
    const finalTicketRun = await runSync("ticketsSync", {
      cursor: "ticket-cursor-1",
    })
    const metricRun = await runSync("ticketMetricsSync", {
      cursor: "metric-cursor-1",
    })
    const ticketReconciliationRun = await runSync("ticketsReconciliationSync")
    const ticketReconciliationTailTransitionRun = await runSync(
      "ticketsReconciliationSync",
      ticketReconciliationRun.nextUserContext
    )
    const ticketReconciliationTailRun = await runSync(
      "ticketsReconciliationSync",
      ticketReconciliationTailTransitionRun.nextUserContext
    )
    const ticketReconciliationFinalRun = await runSync(
      "ticketsReconciliationSync",
      ticketReconciliationTailRun.nextUserContext
    )
    const metricReconciliationRun = await runSync(
      "ticketMetricsReconciliationSync"
    )
    const metricReconciliationTailTransitionRun = await runSync(
      "ticketMetricsReconciliationSync",
      metricReconciliationRun.nextUserContext
    )
    const metricReconciliationFinalRun = await runSync(
      "ticketMetricsReconciliationSync",
      metricReconciliationTailTransitionRun.nextUserContext
    )
    const surveyRun = await runSync("surveyResponsesSync")

    const rateLimitError = await captureError(() =>
      fetchPage("acme", "/api/v2/organizations.json")
    )
    const rateLimitWithoutHeader = await captureError(() =>
      fetchPage("acme", "/api/v2/users.json")
    )
    const repeatedSearchCursorError = await captureError(() =>
      fetchTicketsReconciliationPage(reconciliationCutoff, "repeat")
    )
    const missingSearchCursorError = await captureError(() =>
      fetchTicketsReconciliationPage(reconciliationCutoff, "missing-cursor")
    )
    const malformedSearchPageError = await captureError(() =>
      fetchTicketsReconciliationPage(reconciliationCutoff, "malformed-page")
    )
    const missingMetricSideloadError = await captureError(() =>
      fetchTicketMetricsPage("missing-metric-sideload", reconciliationTailStart)
    )

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
    const ticketSearchUrl = requestedUrls.find(
      (url) =>
        url.pathname === "/api/v2/search/export" &&
        url.searchParams.get("include") ===
          "tickets(users,groups,organizations)" &&
        !url.searchParams.has("page[after]")
    )
    const metricSearchUrl = requestedUrls.find(
      (url) =>
        url.pathname === "/api/v2/search/export" &&
        url.searchParams.get("include") === "tickets(metric_sets)" &&
        !url.searchParams.has("page[after]")
    )
    const ticketCutoff = ticketReconciliationRun.nextUserContext?.cutoff
    const metricCutoff = metricReconciliationRun.nextUserContext?.cutoff
    const tailStart = ticketCutoff
      ? Math.floor(Date.parse(ticketCutoff) / 1_000)
      : undefined
    const continuedTicketSearchUrl = requestedUrls.find(
      (url) =>
        url.pathname === "/api/v2/search/export" &&
        url.searchParams.get("page[after]") === "ticket-search-cursor"
    )
    const capabilityTicketTailUrl = requestedUrls.find(
      (url) =>
        url.pathname === "/api/v2/incremental/tickets/cursor" &&
        url.searchParams.get("include") === "users,groups,organizations" &&
        url.searchParams.get("start_time") === String(tailStart)
    )
    ok(
      "ticket reconciliation uses a pinned archived-ticket Search Export",
      ticketSearchUrl?.searchParams.get("filter[type]") === "ticket" &&
        ticketSearchUrl.searchParams.get("query") ===
          `created<=${ticketCutoff}` &&
        ticketSearchUrl.searchParams.get("page[size]") === "100" &&
        continuedTicketSearchUrl?.searchParams.get("query") ===
          `created<=${ticketCutoff}`
    )
    ok(
      "metric reconciliation uses archived ticket metric sideloads",
      metricSearchUrl?.searchParams.get("query") ===
        `created<=${metricCutoff}` &&
        metricReconciliationRun.changes.some(
          (change) => change.type === "upsert" && change.key === "42"
        )
    )
    ok(
      "manual reconciliation capabilities preserve cutoff state and finish only after the tail",
      ticketReconciliationRun.changes.some(
        (change) => change.type === "upsert" && change.key === "42"
      ) &&
        !ticketReconciliationRun.changes.some(
          (change) => change.key === "777"
        ) &&
        !metricReconciliationRun.changes.some(
          (change) => change.key === "777"
        ) &&
        ticketReconciliationRun.nextUserContext?.phase === "search" &&
        ticketCutoff != null &&
        Object.keys(ticketReconciliationRun.nextUserContext)
          .sort()
          .join(",") === "cursor,cutoff,phase" &&
        ticketReconciliationTailTransitionRun.hasMore &&
        ticketReconciliationTailTransitionRun.nextUserContext?.phase ===
          "tail" &&
        ticketReconciliationTailTransitionRun.nextUserContext?.cursor ===
          undefined &&
        ticketReconciliationTailTransitionRun.nextUserContext?.cutoff ===
          ticketCutoff &&
        ticketReconciliationTailRun.hasMore &&
        ticketReconciliationTailRun.nextUserContext?.phase === "tail" &&
        ticketReconciliationTailRun.nextUserContext?.cursor ===
          "ticket-cursor-1" &&
        ticketReconciliationTailRun.changes.some(
          (change) => change.type === "upsert" && change.key === "777"
        ) &&
        metricReconciliationTailTransitionRun.nextUserContext?.phase ===
          "tail" &&
        !metricReconciliationFinalRun.hasMore &&
        metricReconciliationFinalRun.changes.some(
          (change) => change.type === "upsert" && change.key === "777"
        ) &&
        !ticketReconciliationFinalRun.hasMore &&
        capabilityTicketTailUrl != null
    )
    ok(
      "reconciliation tails delete keys previously seen during Search",
      ticketReconciliationRun.changes.some(
        (change) => change.type === "upsert" && change.key === "42"
      ) &&
        ticketReconciliationTailRun.changes.some(
          (change) => change.type === "delete" && change.key === "42"
        ) &&
        !ticketReconciliationTailRun.changes.some(
          (change) => change.type === "upsert" && change.key === "42"
        ) &&
        metricReconciliationRun.changes.some(
          (change) => change.type === "upsert" && change.key === "42"
        ) &&
        metricReconciliationFinalRun.changes.some(
          (change) => change.type === "delete" && change.key === "42"
        ) &&
        !metricReconciliationFinalRun.changes.some(
          (change) => change.type === "upsert" && change.key === "42"
        )
    )
    ok(
      "empty Search Export pages advance with their continuation cursor",
      emptyTicketReconciliationContinuation.tickets.length === 0 &&
        emptyTicketReconciliationContinuation.hasMore &&
        emptyTicketReconciliationContinuation.nextCursor ===
          "empty-continuation-next" &&
        emptyMetricReconciliationContinuation.metrics.length === 0 &&
        emptyMetricReconciliationContinuation.hasMore &&
        emptyMetricReconciliationContinuation.nextCursor ===
          "empty-continuation-next"
    )
    ok(
      "malformed Search Export pages and cursors fail closed",
      repeatedSearchCursorError instanceof Error &&
        repeatedSearchCursorError.message.includes("repeated its cursor") &&
        missingSearchCursorError instanceof Error &&
        missingSearchCursorError.message.includes("missing its after_cursor") &&
        malformedSearchPageError instanceof Error &&
        malformedSearchPageError.message.includes("returned an invalid page")
    )
    ok(
      "reconciliation rejects missing metric sideloads",
      missingMetricSideloadError instanceof Error &&
        missingMetricSideloadError.message.includes(
          "missing its metric_sets sideload"
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
