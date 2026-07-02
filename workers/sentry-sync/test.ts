// Offline regression tests for the Sentry sync Worker.
// Run from this directory with `npm test`.

import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { RateLimitError } from "@notionhq/workers"

import {
  escapeMarkdown,
  formatSentryLabel,
  issuePageContent,
  nonnegativeNumber,
  safeHttpUrl,
  selectText,
  summedStats,
  titleText,
} from "./src/helpers.js"
import worker from "./src/index.js"
import { issueToChange } from "./src/issues.js"
import {
  buildIssuesUrl,
  fetchIssuesPage,
  getIssueScope,
  nextCursorFromLink,
  parseRetryAfterSeconds,
  rateLimitRetryAfterSeconds,
  type SentryIssue,
  type SentryIssueScope,
} from "./src/sentry.js"
import {
  ISSUE_WINDOW_DAYS,
  issueWindow,
  nextIssueState,
  type IssueSyncState,
} from "./src/sync-state.js"

const originalFetch = globalThis.fetch
const originalDateNow = Date.now
const originalEnv = {
  SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN,
  SENTRY_ORG_SLUG: process.env.SENTRY_ORG_SLUG,
  SENTRY_PROJECTS: process.env.SENTRY_PROJECTS,
  SENTRY_ENVIRONMENTS: process.env.SENTRY_ENVIRONMENTS,
  SENTRY_BASE_URL: process.env.SENTRY_BASE_URL,
}

afterEach(() => {
  globalThis.fetch = originalFetch
  Date.now = originalDateNow
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

const fullIssue: SentryIssue = {
  id: "4500000000000001",
  shortId: "CHECKOUT-42",
  title: "TypeError: Cannot read properties of undefined",
  culprit: "checkout.submitOrder",
  permalink: "https://acme.sentry.io/issues/4500000000000001/",
  status: "unresolved",
  substatus: "regressed",
  priority: "high",
  level: "fatal",
  isUnhandled: true,
  assignedTo: { name: "Ada Lovelace" },
  project: {
    id: "99",
    name: "Checkout API",
    slug: "checkout-api",
    platform: "node",
  },
  platform: "node",
  issueCategory: "error",
  issueType: "error",
  count: "1200",
  userCount: 87,
  lifetime: { count: "5000", userCount: 250 },
  firstSeen: "2026-06-20T10:11:12.000Z",
  lastSeen: "2026-07-02T14:15:16.000Z",
  stats: {
    "24h": [
      [1_751_465_600, 20],
      [1_751_469_200, 7],
    ],
  },
}

const minimalIssue: SentryIssue = {
  id: "4500000000000002",
  shortId: null,
  title: "Needs triage",
  culprit: null,
  permalink: null,
  status: null,
  substatus: null,
  priority: null,
  level: null,
  isUnhandled: null,
  assignedTo: null,
  project: null,
  platform: null,
  issueCategory: null,
  issueType: null,
  count: null,
  userCount: null,
  lifetime: null,
  firstSeen: null,
  lastSeen: null,
  stats: null,
}

const defaultScope: SentryIssueScope = {
  baseUrl: "https://sentry.io/",
  organization: "acme",
  projects: [],
  environments: [],
  credentialFingerprint: "test-only-fingerprint",
}

function propertyText(value: unknown): string {
  return JSON.stringify(value)
}

function assertPropertyContains(value: unknown, expected: string): void {
  assert.match(
    propertyText(value),
    new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  )
}

function configureEnvironment(): void {
  process.env.SENTRY_AUTH_TOKEN = "sentry-test-token"
  process.env.SENTRY_ORG_SLUG = "acme"
  delete process.env.SENTRY_PROJECTS
  delete process.env.SENTRY_ENVIRONMENTS
  delete process.env.SENTRY_BASE_URL
}

function terminalLink(requestUrl: URL): string {
  const previous = new URL(requestUrl)
  previous.searchParams.set("cursor", "previous:0:0")
  const next = new URL(requestUrl)
  next.searchParams.set("cursor", "next:0:0")
  return `<${previous}>; rel="previous"; results="false", <${next}>; rel="next"; results="false"`
}

function nextLink(requestUrl: URL, cursor = "next:100:0"): string {
  const previous = new URL(requestUrl)
  previous.searchParams.set("cursor", "previous:0:0")
  const next = new URL(requestUrl)
  next.searchParams.set("cursor", cursor)
  return `<${previous}>; rel="previous"; results="false", <${next}>; rel="next"; results="true"`
}

function rawIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: fullIssue.id,
    shortId: fullIssue.shortId,
    title: fullIssue.title,
    culprit: fullIssue.culprit,
    permalink: fullIssue.permalink,
    status: fullIssue.status,
    substatus: fullIssue.substatus,
    priority: fullIssue.priority,
    level: fullIssue.level,
    isUnhandled: fullIssue.isUnhandled,
    assignedTo: {
      type: "user",
      id: "user-1",
      name: fullIssue.assignedTo?.name,
      email: "private@example.com",
    },
    project: fullIssue.project,
    platform: fullIssue.platform,
    issueCategory: fullIssue.issueCategory,
    issueType: fullIssue.issueType,
    count: fullIssue.count,
    userCount: fullIssue.userCount,
    lifetime: fullIssue.lifetime,
    firstSeen: fullIssue.firstSeen,
    lastSeen: fullIssue.lastSeen,
    stats: fullIssue.stats,
    metadata: { value: "sensitive metadata" },
    latestEvent: { stacktrace: "sensitive stack trace" },
    ...overrides,
  }
}

test("manifest exposes one value-first rolling issue database", () => {
  assert.deepEqual(
    worker.manifest.databases.map((database) => ({
      key: database.key,
      title: database.config.initialTitle,
      primaryKey: database.config.primaryKeyProperty,
      icon: database.config.schema.databaseIcon,
      firstSix: Object.keys(database.config.schema.properties).slice(0, 6),
    })),
    [
      {
        key: "issues",
        title: "Sentry Issues — Last 30 Days",
        primaryKey: "Sentry Issue ID",
        icon: { type: "notion", icon: "bug", color: "gray" },
        firstSix: [
          "Issue",
          "Status",
          "Assignee",
          "Issue Link",
          "Last Seen",
          "Priority",
        ],
      },
    ]
  )

  assert.deepEqual(
    worker.manifest.capabilities.map((capability) => {
      assert.equal(capability._tag, "sync")
      const config = capability.config as {
        databaseKey: string
        mode: string
        schedule: { type: string; intervalMs: number }
      }
      return {
        key: capability.key,
        databaseKey: config.databaseKey,
        mode: config.mode,
        schedule: config.schedule,
      }
    }),
    [
      {
        key: "issuesSync",
        databaseKey: "issues",
        mode: "replace",
        schedule: { type: "interval", intervalMs: 15 * 60_000 },
      },
    ]
  )

  assert.deepEqual(worker.manifest.pacers, [
    {
      key: "sentry",
      config: { allowedRequests: 60, intervalMs: 60_000 },
    },
  ])
})

test("issue transform keeps stable identity and actionable impact fields", () => {
  const change = issueToChange(fullIssue)
  const properties = change.properties as Record<string, unknown>

  assert.equal(change.key, fullIssue.id)
  assert.equal("upstreamUpdatedAt" in change, false)
  assert.deepEqual(Object.keys(properties).slice(0, 6), [
    "Issue",
    "Status",
    "Assignee",
    "Issue Link",
    "Last Seen",
    "Priority",
  ])
  assertPropertyContains(properties.Issue, fullIssue.title)
  assertPropertyContains(properties.Status, "Unresolved")
  assertPropertyContains(properties["Status Detail"], "Regressed")
  assertPropertyContains(properties.Assignee, "Ada Lovelace")
  assertPropertyContains(properties["Events (24h)"], "27")
  assertPropertyContains(properties["Events (30d)"], "1200")
  assertPropertyContains(properties["Users (30d)"], "87")
  assertPropertyContains(properties["Lifetime Events"], "5000")
  assertPropertyContains(properties["Lifetime Users"], "250")
  assertPropertyContains(properties.Project, "Checkout API")
  assertPropertyContains(properties["Sentry Issue ID"], fullIssue.id)
  assert.match(change.pageContentMarkdown, /Triage signals.*Regressed/)
  assert.match(change.pageContentMarkdown, /High priority/)
  assert.match(change.pageContentMarkdown, /Open this issue in Sentry/)
})

test("issue transform omits absent optional fields without inventing false values", () => {
  const change = issueToChange(minimalIssue)
  const properties = change.properties as Record<string, unknown>

  assert.deepEqual(Object.keys(properties), ["Issue", "Sentry Issue ID"])
  assert.equal(properties.Unhandled, undefined)
  assert.equal(properties["Events (24h)"], undefined)
  assert.equal(properties["Events (30d)"], undefined)
  assert.equal(properties["Users (30d)"], undefined)
  assert.equal(properties["Lifetime Events"], undefined)
  assert.equal(properties["Lifetime Users"], undefined)
  assert.match(change.pageContentMarkdown, /Status:\*\* Not provided/)
})

test("zero counts and false unhandled values remain meaningful", () => {
  const change = issueToChange({
    ...minimalIssue,
    count: "0",
    userCount: 0,
    lifetime: { count: "0", userCount: 0 },
    isUnhandled: false,
    stats: { "24h": [] },
  })
  const properties = change.properties as Record<string, unknown>

  assertPropertyContains(properties["Events (24h)"], "0")
  assertPropertyContains(properties["Events (30d)"], "0")
  assertPropertyContains(properties["Users (30d)"], "0")
  assertPropertyContains(properties["Lifetime Events"], "0")
  assertPropertyContains(properties["Lifetime Users"], "0")
  assertPropertyContains(properties.Unhandled, "No")
})

test("display helpers preserve unknown values and bound provider text", () => {
  assert.equal(
    formatSentryLabel("archived_until_escalating"),
    "Archived Until Escalating"
  )
  assert.equal(selectText("custom_future-state"), "Custom Future State")
  assert.equal(nonnegativeNumber("12"), 12)
  assert.equal(nonnegativeNumber("not-a-number"), null)
  assert.equal(nonnegativeNumber(-1), null)
  assert.equal(
    summedStats(
      {
        "24h": [
          [1, 0],
          [2, 4],
        ],
      },
      "24h"
    ),
    4
  )
  assert.equal(summedStats({ "24h": [[1, -1]] }, "24h"), null)
  assert.equal(safeHttpUrl("javascript:alert(1)"), null)
  assert.equal(escapeMarkdown("[prod] *fatal*"), "\\[prod\\] \\*fatal\\*")
  assert.equal(Array.from(titleText("x".repeat(3_000))).length, 2_000)
})

test("triage page content is bounded and excludes data that was never selected", () => {
  const content = issuePageContent({
    ...fullIssue,
    culprit: `danger [link] ${"x".repeat(2_000)}`,
  })

  assert.ok(content.length < 3_000)
  assert.ok(content.includes("danger \\[link\\]"))
  assert.doesNotMatch(content, /private@example\.com/)
  assert.doesNotMatch(content, /stack trace|breadcrumbs|request body/i)
})

test("issue window is exactly 30 days and remains pinned between pages", () => {
  const now = Date.parse("2026-07-02T15:00:00.000Z")
  const window = issueWindow(undefined, now)
  assert.equal(
    Date.parse(window.end) - Date.parse(window.start),
    ISSUE_WINDOW_DAYS * 86_400_000
  )

  const state: IssueSyncState = {
    ...window,
    scope: defaultScope,
    cursor: "cursor-a",
    seenCursors: ["cursor-a"],
  }
  assert.deepEqual(issueWindow(state, now + 7 * 86_400_000), window)
})

test("cursor state catches immediate and longer pagination loops", () => {
  const window = {
    start: "2026-06-02T15:00:00.000Z",
    end: "2026-07-02T15:00:00.000Z",
  }
  const first = nextIssueState(undefined, window, defaultScope, "cursor-a")
  const second = nextIssueState(first, window, defaultScope, "cursor-b")

  assert.equal(first.cursor, "cursor-a")
  assert.deepEqual(second.seenCursors, ["cursor-a", "cursor-b"])
  assert.throws(
    () => nextIssueState(first, window, defaultScope, "cursor-a"),
    /repeated/
  )
  assert.throws(
    () => nextIssueState(second, window, defaultScope, "cursor-a"),
    /repeated/
  )
  assert.throws(
    () => nextIssueState(second, window, defaultScope, undefined),
    /missing/
  )
})

test("request URL explicitly includes all statuses and repeatable filters", () => {
  configureEnvironment()
  process.env.SENTRY_BASE_URL = "https://errors.example.com/sentry/"
  process.env.SENTRY_PROJECTS = "checkout, 42, checkout"
  process.env.SENTRY_ENVIRONMENTS = "production, staging"

  const url = buildIssuesUrl({
    start: "2026-06-02T15:00:00.000Z",
    end: "2026-07-02T15:00:00.000Z",
    cursor: "opaque:100:0",
  })

  assert.equal(url.pathname, "/sentry/api/0/organizations/acme/issues/")
  assert.equal(url.searchParams.has("query"), true)
  assert.equal(url.searchParams.get("query"), "")
  assert.equal(url.searchParams.get("sort"), "new")
  assert.equal(url.searchParams.get("groupStatsPeriod"), "24h")
  assert.equal(url.searchParams.get("limit"), "100")
  assert.deepEqual(url.searchParams.getAll("project"), ["checkout", "42"])
  assert.deepEqual(url.searchParams.getAll("environment"), [
    "production",
    "staging",
  ])
  assert.equal(url.searchParams.get("cursor"), "opaque:100:0")
})

test("base URL validation rejects unsafe or ambiguous configuration", () => {
  configureEnvironment()
  process.env.SENTRY_BASE_URL = "file:///tmp/sentry"
  assert.throws(
    () =>
      buildIssuesUrl({
        start: "2026-06-02T15:00:00.000Z",
        end: "2026-07-02T15:00:00.000Z",
      }),
    /must use HTTPS/
  )

  process.env.SENTRY_BASE_URL = "http://sentry.internal"
  assert.throws(
    () =>
      buildIssuesUrl({
        start: "2026-06-02T15:00:00.000Z",
        end: "2026-07-02T15:00:00.000Z",
      }),
    /must use HTTPS/
  )

  process.env.SENTRY_BASE_URL = "http://127.0.0.1:8000"
  assert.equal(
    buildIssuesUrl({
      start: "2026-06-02T15:00:00.000Z",
      end: "2026-07-02T15:00:00.000Z",
    }).origin,
    "http://127.0.0.1:8000"
  )

  process.env.SENTRY_BASE_URL = "https://user:password@example.com"
  assert.throws(
    () =>
      buildIssuesUrl({
        start: "2026-06-02T15:00:00.000Z",
        end: "2026-07-02T15:00:00.000Z",
      }),
    /cannot contain credentials/
  )

  process.env.SENTRY_BASE_URL = "https://example.com/api/0"
  assert.throws(
    () =>
      buildIssuesUrl({
        start: "2026-06-02T15:00:00.000Z",
        end: "2026-07-02T15:00:00.000Z",
      }),
    /server root/
  )

  process.env.SENTRY_BASE_URL = "https://example.com"
  process.env.SENTRY_ORG_SLUG = "../another-path"
  assert.throws(
    () =>
      buildIssuesUrl({
        start: "2026-06-02T15:00:00.000Z",
        end: "2026-07-02T15:00:00.000Z",
      }),
    /SENTRY_ORG_SLUG/
  )
})

test("Link parser follows next only when Sentry says results=true", () => {
  configureEnvironment()
  const requestUrl = buildIssuesUrl({
    start: "2026-06-02T15:00:00.000Z",
    end: "2026-07-02T15:00:00.000Z",
  })

  assert.equal(
    nextCursorFromLink(nextLink(requestUrl), requestUrl),
    "next:100:0"
  )
  assert.equal(
    nextCursorFromLink(terminalLink(requestUrl), requestUrl),
    undefined
  )

  const next = new URL(requestUrl)
  next.searchParams.set("cursor", "cursor-with-comma")
  const previous = new URL(requestUrl)
  const quotedComma = `<${next}>; title="next, page"; results="true"; rel="next", <${previous}>; results="false"; rel="previous"`
  assert.equal(nextCursorFromLink(quotedComma, requestUrl), "cursor-with-comma")
})

test("Link parser fails closed on missing, duplicate, malformed, or untrusted next links", () => {
  configureEnvironment()
  const requestUrl = buildIssuesUrl({
    start: "2026-06-02T15:00:00.000Z",
    end: "2026-07-02T15:00:00.000Z",
  })
  const valid = nextLink(requestUrl)

  assert.throws(() => nextCursorFromLink(null, requestUrl), /missing its Link/)
  assert.throws(
    () => nextCursorFromLink(`${valid}, ${valid}`, requestUrl),
    /one next Link/
  )
  assert.throws(
    () =>
      nextCursorFromLink(
        `<${requestUrl}>; rel="next"; results="maybe"`,
        requestUrl
      ),
    /invalid results/
  )
  assert.throws(
    () =>
      nextCursorFromLink(
        `<https://attacker.example/api/0/issues/?cursor=stolen>; rel="next"; results="true"`,
        requestUrl
      ),
    /untrusted/
  )
  assert.throws(
    () =>
      nextCursorFromLink(
        `<${requestUrl}>; rel="next"; results="true"`,
        requestUrl
      ),
    /missing its next cursor/
  )
})

test("API client authenticates, paces once, and retains only selected group fields", async () => {
  configureEnvironment()
  let waits = 0
  const requests: Request[] = []
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    requests.push(request)
    return new Response(JSON.stringify([rawIssue()]), {
      status: 200,
      headers: { Link: terminalLink(new URL(request.url)) },
    })
  }) as typeof fetch

  const page = await fetchIssuesPage(
    async () => {
      waits += 1
    },
    {
      start: "2026-06-02T15:00:00.000Z",
      end: "2026-07-02T15:00:00.000Z",
    }
  )

  assert.equal(waits, 1)
  assert.equal(requests.length, 1)
  assert.equal(
    requests[0].headers.get("Authorization"),
    "Bearer sentry-test-token"
  )
  assert.equal(
    requests[0].headers.get("User-Agent"),
    "notion-cookbook-sentry-sync"
  )
  assert.equal(page.hasMore, false)
  assert.equal(page.resources[0].id, fullIssue.id)
  assert.equal(page.resources[0].assignedTo?.name, "Ada Lovelace")
  assert.equal(page.resources[0].lifetime?.count, "5000")
  assert.equal("email" in (page.resources[0].assignedTo ?? {}), false)
  assert.equal("metadata" in page.resources[0], false)
  assert.equal("latestEvent" in page.resources[0], false)
})

test("API client trusts Link results rather than page length", async () => {
  configureEnvironment()
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    return new Response(JSON.stringify([rawIssue()]), {
      status: 200,
      headers: { Link: nextLink(new URL(request.url), "cursor-b") },
    })
  }) as typeof fetch

  const page = await fetchIssuesPage(async () => undefined, {
    start: "2026-06-02T15:00:00.000Z",
    end: "2026-07-02T15:00:00.000Z",
  })
  assert.equal(page.resources.length, 1)
  assert.equal(page.hasMore, true)
  assert.equal(page.nextCursor, "cursor-b")
})

test("API client fails closed if credentials change between pages", async () => {
  configureEnvironment()
  const scope = getIssueScope()
  process.env.SENTRY_AUTH_TOKEN = "rotated-token-with-different-access"
  let fetched = false
  globalThis.fetch = (async () => {
    fetched = true
    throw new Error("fetch should not be called")
  }) as typeof fetch

  await assert.rejects(
    fetchIssuesPage(
      async () => undefined,
      {
        start: "2026-06-02T15:00:00.000Z",
        end: "2026-07-02T15:00:00.000Z",
      },
      scope
    ),
    /changed during Sentry issue pagination/
  )
  assert.equal(fetched, false)
})

test("API client rejects malformed JSON, shapes, and required issue fields", async () => {
  configureEnvironment()
  const options = {
    start: "2026-06-02T15:00:00.000Z",
    end: "2026-07-02T15:00:00.000Z",
  }

  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    return new Response("not json", {
      status: 200,
      headers: { Link: terminalLink(new URL(request.url)) },
    })
  }) as typeof fetch
  await assert.rejects(
    fetchIssuesPage(async () => undefined, options),
    /invalid JSON/
  )

  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { Link: terminalLink(new URL(request.url)) },
    })
  }) as typeof fetch
  await assert.rejects(
    fetchIssuesPage(async () => undefined, options),
    /must be a JSON array/
  )

  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    return new Response(JSON.stringify([rawIssue({ id: null })]), {
      status: 200,
      headers: { Link: terminalLink(new URL(request.url)) },
    })
  }) as typeof fetch
  await assert.rejects(
    fetchIssuesPage(async () => undefined, options),
    /missing its immutable id/
  )
})

test("rate-limit helpers accept delta/date headers and Sentry reset epochs", () => {
  const now = Date.parse("2026-07-02T15:00:00.000Z")
  assert.equal(parseRetryAfterSeconds("7", now), 7)
  assert.equal(parseRetryAfterSeconds("Thu, 02 Jul 2026 15:00:09 GMT", now), 9)
  assert.equal(parseRetryAfterSeconds("invalid", now), undefined)
  assert.equal(rateLimitRetryAfterSeconds(new Headers(), now), undefined)

  assert.equal(
    rateLimitRetryAfterSeconds(
      new Headers({
        "X-Sentry-Rate-Limit-Remaining": "0",
        "X-Sentry-Rate-Limit-Reset": String(now / 1_000 + 12),
        "Retry-After": "5",
      }),
      now
    ),
    12
  )
})

test("429 becomes a platform-aware RateLimitError while ordinary 403 remains generic", async () => {
  configureEnvironment()
  const options = {
    start: "2026-06-02T15:00:00.000Z",
    end: "2026-07-02T15:00:00.000Z",
  }

  globalThis.fetch = (async () =>
    new Response("slow down", {
      status: 429,
      headers: { "Retry-After": "11" },
    })) as typeof fetch
  const rateError = await fetchIssuesPage(async () => undefined, options).catch(
    (error: unknown) => error
  )
  assert.ok(rateError instanceof RateLimitError)
  assert.equal(rateError.retryAfter, 11)

  globalThis.fetch = (async () =>
    new Response("slow down", { status: 429 })) as typeof fetch
  const headerlessRateError = await fetchIssuesPage(
    async () => undefined,
    options
  ).catch((error: unknown) => error)
  assert.ok(headerlessRateError instanceof RateLimitError)
  assert.equal(headerlessRateError.retryAfter, undefined)

  globalThis.fetch = (async () =>
    new Response("forbidden", { status: 403 })) as typeof fetch
  const permissionError = await fetchIssuesPage(
    async () => undefined,
    options
  ).catch((error: unknown) => error)
  assert.ok(permissionError instanceof Error)
  assert.equal(permissionError instanceof RateLimitError, false)
  assert.match(permissionError.message, /Sentry API error \(403\)/)
})

type WorkerRunResult = {
  changes: Array<{ key: string; targetDatabaseKey: string }>
  hasMore: boolean
  nextUserContext?: IssueSyncState
}

function sentryPacerContext(state?: IssueSyncState) {
  return {
    state,
    pacers: {
      sentry: {
        lastScheduledAtMs: 0,
        allowedRequests: 1_000_000,
        intervalMs: 1,
      },
    },
  }
}

test("Worker run pins its 30-day window and advances opaque cursor state", async () => {
  configureEnvironment()
  process.env.SENTRY_PROJECTS = "checkout-api"
  process.env.SENTRY_ENVIRONMENTS = "production"
  const now = Date.parse("2026-07-02T15:00:00.000Z")
  Date.now = () => now
  const requestUrls: URL[] = []
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    const requestUrl = new URL(request.url)
    requestUrls.push(requestUrl)
    return new Response(JSON.stringify([rawIssue()]), {
      status: 200,
      headers: { Link: nextLink(requestUrl, "cursor-page-2") },
    })
  }) as typeof fetch

  const first = (await worker.run("issuesSync", sentryPacerContext(), {
    concreteOutput: true,
  })) as WorkerRunResult

  assert.equal(first.hasMore, true)
  assert.equal(first.changes.length, 1)
  assert.equal(first.changes[0].key, fullIssue.id)
  assert.equal(first.changes[0].targetDatabaseKey, "issues")
  assert.equal(first.nextUserContext?.cursor, "cursor-page-2")
  assert.deepEqual(first.nextUserContext?.scope.projects, ["checkout-api"])
  assert.deepEqual(first.nextUserContext?.scope.environments, ["production"])
  assert.equal(
    Date.parse(first.nextUserContext?.end ?? "") -
      Date.parse(first.nextUserContext?.start ?? ""),
    ISSUE_WINDOW_DAYS * 86_400_000
  )

  Date.now = () => now + 7 * 86_400_000
  process.env.SENTRY_PROJECTS = "billing-api"
  process.env.SENTRY_ENVIRONMENTS = "staging"
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    const requestUrl = new URL(request.url)
    requestUrls.push(requestUrl)
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { Link: terminalLink(requestUrl) },
    })
  }) as typeof fetch

  const second = (await worker.run(
    "issuesSync",
    sentryPacerContext(first.nextUserContext),
    { concreteOutput: true }
  )) as WorkerRunResult

  assert.equal(second.hasMore, false)
  assert.equal(second.nextUserContext, undefined)
  assert.equal(requestUrls[1].searchParams.get("cursor"), "cursor-page-2")
  assert.deepEqual(requestUrls[1].searchParams.getAll("project"), [
    "checkout-api",
  ])
  assert.deepEqual(requestUrls[1].searchParams.getAll("environment"), [
    "production",
  ])
  assert.equal(
    requestUrls[1].searchParams.get("start"),
    requestUrls[0].searchParams.get("start")
  )
  assert.equal(
    requestUrls[1].searchParams.get("end"),
    requestUrls[0].searchParams.get("end")
  )
  assert.equal(requestUrls.length, 2, "one request is made for each API page")
})
