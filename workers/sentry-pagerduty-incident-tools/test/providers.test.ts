import assert from "node:assert/strict"
import test from "node:test"

import type { WorkerConfig } from "../src/config.js"
import { getJson, postJsonOnce, ProviderError } from "../src/api-requests.js"
import { PagerDutyClient } from "../src/pagerduty.js"
import { SentryClient, SentryStateError } from "../src/sentry.js"

function config(): WorkerConfig {
  return {
    sentryToken: "sentry-token",
    sentryOrgSlug: "acme",
    sentryProjectSlug: "checkout-api",
    sentryEnvironment: "production",
    sentryBaseUrl: "https://sentry.io",
    pagerDutyToken: "pagerduty-token",
    pagerDutyFromEmail: "incident-bot@example.com",
    pagerDutyServiceId: "service-1",
    pagerDutyPriorityIds: {
      sev1: "priority-1",
      sev2: "priority-2",
      sev3: "priority-3",
    },
    pagerDutyBaseUrl: "https://api.pagerduty.com",
    requestTimeoutMs: 1_000,
  }
}

function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}

function issue(id: number) {
  return {
    id: String(id),
    shortId: `CHECKOUT-${id}`,
    title: `Checkout failure ${id}`,
    status: "unresolved",
    substatus: "ongoing",
    count: String(id),
    lastSeen: "2026-07-05T15:00:00Z",
    permalink: `https://acme.sentry.io/issues/${id}/`,
    project: { id: "42", slug: "checkout-api" },
  }
}

test("Sentry search fixes scope and returns a bounded candidate list", async () => {
  const request = { value: null as URL | null }
  const client = new SentryClient(config(), async (input) => {
    request.value = new URL(String(input))
    return json(Array.from({ length: 11 }, (_, index) => issue(index + 1)))
  })

  const result = await client.searchIssues("error.type:checkout", "1h")
  assert.equal(result.issues.length, 10)
  assert.equal(result.hasMore, true)
  assert.equal(result.issues[0]?.shortId, "CHECKOUT-1")
  assert.ok(request.value)
  assert.equal(request.value.pathname, "/api/0/organizations/acme/issues/")
  assert.equal(request.value.searchParams.get("project"), "checkout-api")
  assert.equal(request.value.searchParams.get("environment"), "production")
  assert.equal(
    request.value.searchParams.get("query"),
    "is:unresolved error.type:checkout"
  )
  assert.equal(request.value.searchParams.get("statsPeriod"), "1h")
  assert.equal(request.value.searchParams.get("limit"), "11")
})

test("Sentry inspection resolves a visible short ID and returns only bounded identity", async () => {
  const paths: string[] = []
  const client = new SentryClient(config(), async (input) => {
    const url = new URL(String(input))
    paths.push(url.pathname)
    if (url.pathname.endsWith("/shortids/CHECKOUT-431/")) {
      return json({
        organizationSlug: "acme",
        projectSlug: "checkout-api",
        shortId: "CHECKOUT-431",
        group: { id: "123" },
      })
    }
    if (url.pathname.endsWith("/issues/123/")) return json(issue(123))
    if (url.pathname.endsWith("/issues/123/events/latest/")) {
      return json({
        eventID: "a".repeat(32),
        groupID: "123",
        projectID: "42",
        title: "Payment confirmation timed out",
        dateCreated: "2026-07-05T15:01:00Z",
        tags: [{ key: "environment", value: "production" }],
        user: { email: "private@example.com" },
        entries: [{ type: "exception", data: "private stack" }],
      })
    }
    throw new Error(`unexpected ${url}`)
  })

  const inspection = await client.inspectIssue("CHECKOUT-431")
  assert.equal(inspection.issue.issueId, "123")
  assert.equal(inspection.event.eventId, "a".repeat(32))
  assert.deepEqual(paths, [
    "/api/0/organizations/acme/shortids/CHECKOUT-431/",
    "/api/0/organizations/acme/issues/123/",
    "/api/0/organizations/acme/issues/123/events/latest/",
  ])
  assert.doesNotMatch(
    JSON.stringify(inspection),
    /private@example|private stack/
  )
})

test("Sentry rejects an untrusted issue URL without fetching it", async () => {
  let calls = 0
  const client = new SentryClient(config(), async () => {
    calls += 1
    throw new Error("should not fetch")
  })
  await assert.rejects(
    () => client.inspectIssue("https://evil.example/issues/123/"),
    SentryStateError
  )
  assert.equal(calls, 0)
})

test("Sentry accepts a canonical issue URL with a regional API base", async () => {
  const regional = { ...config(), sentryBaseUrl: "https://us.sentry.io" }
  const paths: string[] = []
  const client = new SentryClient(regional, async (input) => {
    const url = new URL(String(input))
    paths.push(url.pathname)
    if (url.pathname.endsWith("/issues/123/")) return json(issue(123))
    if (url.pathname.endsWith("/issues/123/events/latest/")) {
      return json({
        eventID: "a".repeat(32),
        groupID: "123",
        projectID: "42",
        title: "Payment confirmation timed out",
        dateCreated: "2026-07-05T15:01:00Z",
        tags: [{ key: "environment", value: "production" }],
      })
    }
    throw new Error(`unexpected ${url}`)
  })

  const inspection = await client.inspectIssue(
    "https://acme.sentry.io/issues/123/"
  )
  assert.equal(inspection.issue.issueId, "123")
  assert.deepEqual(paths, [
    "/api/0/organizations/acme/issues/123/",
    "/api/0/organizations/acme/issues/123/events/latest/",
  ])
})

test("Sentry rejects a malformed event identity", async () => {
  const client = new SentryClient(config(), async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/issues/123/")) return json(issue(123))
    if (url.pathname.endsWith("/issues/123/events/latest/")) {
      return json({
        eventID: "not-an-event-id",
        groupID: "123",
        projectID: "42",
        title: "Payment confirmation timed out",
        dateCreated: "2026-07-05T15:01:00Z",
        tags: [{ key: "environment", value: "production" }],
      })
    }
    throw new Error(`unexpected ${url}`)
  })

  await assert.rejects(() => client.inspectIssue("123"), ProviderError)
})

test("Sentry rechecks unresolved status after reading the exact event", async () => {
  let issueReads = 0
  const eventId = "a".repeat(32)
  const client = new SentryClient(config(), async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/issues/123/")) {
      issueReads += 1
      return json({
        ...issue(123),
        status: issueReads === 1 ? "unresolved" : "resolved",
      })
    }
    if (url.pathname.endsWith(`/issues/123/events/${eventId}/`)) {
      return json({
        eventID: eventId,
        groupID: "123",
        projectID: "42",
        title: "Payment confirmation timed out",
        dateCreated: "2026-07-05T15:01:00Z",
        tags: [{ key: "environment", value: "production" }],
      })
    }
    throw new Error(`unexpected ${url}`)
  })

  await assert.rejects(
    () => client.verifyEvent("123", eventId),
    (error: unknown) =>
      error instanceof SentryStateError && error.kind === "conflict"
  )
  assert.equal(issueReads, 2)
})

test("PagerDuty destination verifies service, priorities, and current coverage", async () => {
  const paths: string[] = []
  const client = new PagerDutyClient(config(), {
    now: () => new Date("2026-07-05T15:00:00Z"),
    fetch: async (input) => {
      const url = new URL(String(input))
      paths.push(`${url.pathname}${url.search}`)
      if (url.pathname === "/services/service-1") {
        return json({
          service: {
            id: "service-1",
            name: "Checkout API",
            status: "active",
            html_url: "https://acme.pagerduty.com/service-directory/service-1",
            escalation_policy: { id: "ep-1" },
          },
        })
      }
      if (url.pathname === "/priorities") {
        return json({
          priorities: [
            { id: "priority-1", name: "SEV-1" },
            { id: "priority-2", name: "SEV-2" },
            { id: "priority-3", name: "SEV-3" },
          ],
          more: false,
        })
      }
      if (url.pathname === "/oncalls") {
        return json({ oncalls: [{ escalation_policy: { id: "ep-1" } }] })
      }
      throw new Error(`unexpected ${url}`)
    },
  })

  const destination = await client.getDestination()
  assert.equal(destination.serviceName, "Checkout API")
  assert.equal(destination.hasOnCall, true)
  assert.deepEqual(
    destination.priorities.map(({ severity, priorityName }) => ({
      severity,
      priorityName,
    })),
    [
      { severity: "sev1", priorityName: "SEV-1" },
      { severity: "sev2", priorityName: "SEV-2" },
      { severity: "sev3", priorityName: "SEV-3" },
    ]
  )
  assert.equal(paths.length, 3)
})

test("PagerDuty lookup verifies exact key, service, priority, and pagination", async () => {
  const request = { value: null as URL | null }
  const client = new PagerDutyClient(config(), {
    fetch: async (input) => {
      request.value = new URL(String(input))
      return json({
        incidents: [
          {
            id: "incident-1",
            incident_number: 42,
            status: "triggered",
            incident_key: "event-key",
            service: { id: "service-1" },
            priority: { id: "priority-1", summary: "SEV-1" },
            html_url: "https://acme.pagerduty.com/incidents/incident-1",
          },
        ],
        more: false,
      })
    },
  })
  const incident = await client.findIncident("event-key")
  assert.equal(incident?.incidentId, "incident-1")
  assert.equal(incident?.priorityId, "priority-1")
  assert.ok(request.value)
  assert.deepEqual(request.value.searchParams.getAll("statuses[]"), [
    "triggered",
    "acknowledged",
    "resolved",
  ])
  assert.deepEqual(request.value.searchParams.getAll("include[]"), [
    "priorities",
    "services",
  ])
})

test("PagerDuty creation uses REST priority, From identity, and one deterministic key", async () => {
  const captured = {
    body: null as Record<string, unknown> | null,
    headers: null as Headers | null,
  }
  const client = new PagerDutyClient(config(), {
    fetch: async (_input, init) => {
      captured.headers = new Headers(init?.headers)
      captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return json(
        {
          incident: {
            id: "incident-1",
            incident_number: 42,
            status: "triggered",
            incident_key: "event-key",
            service: { id: "service-1" },
            priority: { id: "priority-1", summary: "SEV-1" },
            html_url: "https://acme.pagerduty.com/incidents/incident-1",
          },
        },
        201,
        { "x-request-id": "request-1" }
      )
    },
  })
  const result = await client.createIncident({
    incidentKey: "event-key",
    priorityId: "priority-1",
    title: "[SEV-1] CHECKOUT-431: Timeout",
    details: "Sentry issue: https://acme.sentry.io/issues/123/",
  })
  assert.equal(captured.headers?.get("from"), "incident-bot@example.com")
  assert.equal(result.requestId, "request-1")
  const incident = captured.body?.incident as Record<string, unknown>
  assert.equal(incident.incident_key, "event-key")
  assert.deepEqual(incident.service, {
    id: "service-1",
    type: "service_reference",
  })
  assert.deepEqual(incident.priority, {
    id: "priority-1",
    type: "priority_reference",
  })
})

test("PagerDuty does not retry a write whose response is lost", async () => {
  let calls = 0
  const client = new PagerDutyClient(config(), {
    fetch: async () => {
      calls += 1
      throw new Error("connection lost")
    },
  })
  await assert.rejects(
    () =>
      client.createIncident({
        incidentKey: "event-key",
        priorityId: "priority-1",
        title: "Incident",
        details: "Details",
      }),
    (error: unknown) =>
      error instanceof ProviderError && error.mutationOutcome === "unknown"
  )
  assert.equal(calls, 1)
})

function stalledResponse(status: number, signal: AbortSignal): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        signal.addEventListener(
          "abort",
          () => controller.error(new Error("aborted")),
          { once: true }
        )
      },
    }),
    { status }
  )
}

test("expired provider deadlines prevent outbound requests", async () => {
  let calls = 0
  const now = () => new Date("2026-07-05T15:00:00Z")
  const expired = now().getTime() - 1
  const fetch = async () => {
    calls += 1
    return json({})
  }

  await assert.rejects(
    () =>
      getJson({
        provider: "Sentry",
        url: new URL("https://sentry.io/api/0/issues/"),
        headers: {},
        fetch,
        timeoutMs: 100,
        deadlineAtMs: expired,
        now,
      }),
    (error: unknown) =>
      error instanceof ProviderError && error.retryable === true
  )
  await assert.rejects(
    () =>
      postJsonOnce({
        provider: "PagerDuty",
        url: new URL("https://api.pagerduty.com/incidents"),
        headers: {},
        body: {},
        fetch,
        timeoutMs: 100,
        deadlineAtMs: expired,
        now,
      }),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.mutationOutcome === "not_attempted"
  )
  assert.equal(calls, 0)
})

test("provider timeout covers response body streaming", async () => {
  await assert.rejects(
    () =>
      getJson({
        provider: "Sentry",
        url: new URL("https://sentry.io/api/0/issues/"),
        headers: {},
        fetch: async (_input, init) =>
          stalledResponse(200, init?.signal as AbortSignal),
        timeoutMs: 5,
        attempts: 1,
      }),
    (error: unknown) =>
      error instanceof ProviderError && error.retryable === true
  )

  await assert.rejects(
    () =>
      postJsonOnce({
        provider: "PagerDuty",
        url: new URL("https://api.pagerduty.com/incidents"),
        headers: {},
        body: {},
        fetch: async (_input, init) =>
          stalledResponse(201, init?.signal as AbortSignal),
        timeoutMs: 5,
      }),
    (error: unknown) =>
      error instanceof ProviderError && error.mutationOutcome === "unknown"
  )
})

test("provider reads do not retry before a longer Retry-After", async () => {
  let calls = 0
  const delays: number[] = []
  await assert.rejects(
    () =>
      getJson({
        provider: "PagerDuty",
        url: new URL("https://api.pagerduty.com/incidents"),
        headers: {},
        fetch: async () => {
          calls += 1
          return json({}, 429, { "retry-after": "10" })
        },
        timeoutMs: 100,
        attempts: 2,
        sleep: async (milliseconds) => {
          delays.push(milliseconds)
        },
      }),
    (error: unknown) =>
      error instanceof ProviderError && error.retryAfterSeconds === 10
  )
  assert.equal(calls, 1)
  assert.deepEqual(delays, [])
})

test("provider reads honor a short Retry-After", async () => {
  let calls = 0
  const delays: number[] = []
  const result = await getJson({
    provider: "PagerDuty",
    url: new URL("https://api.pagerduty.com/incidents"),
    headers: {},
    fetch: async () => {
      calls += 1
      return calls === 1
        ? json({}, 429, { "retry-after": "1" })
        : json({ incidents: [] })
    },
    timeoutMs: 100,
    attempts: 2,
    sleep: async (milliseconds) => {
      delays.push(milliseconds)
    },
  })
  assert.deepEqual(result.data, { incidents: [] })
  assert.equal(calls, 2)
  assert.deepEqual(delays, [1_000])
})

test("provider reads reject malformed and oversized JSON without retrying", async () => {
  for (const body of ["{", JSON.stringify("x".repeat(1024 * 1024))]) {
    let calls = 0
    await assert.rejects(
      () =>
        getJson({
          provider: "Sentry",
          url: new URL("https://sentry.io/api/0/issues/"),
          headers: {},
          fetch: async () => {
            calls += 1
            return new Response(body, { status: 200 })
          },
          timeoutMs: 100,
          attempts: 2,
          sleep: async () => undefined,
        }),
      (error: unknown) =>
        error instanceof ProviderError &&
        /invalid or oversized/.test(error.message)
    )
    assert.equal(calls, 1)
  }
})
