import assert from "node:assert/strict"
import test from "node:test"

import type { WorkerConfig } from "../src/config.js"
import { ProviderError } from "../src/api-requests.js"
import {
  declareProductionIncident,
  incidentKey,
  inspectSentryIssue,
  searchSentryIssues,
} from "../src/incident.js"
import type {
  PagerDutyDestination,
  PagerDutyIncident,
} from "../src/pagerduty.js"
import type { SentryInspection } from "../src/sentry.js"
import { SentryStateError } from "../src/sentry.js"

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

function inspection(eventId = "a".repeat(32)): SentryInspection {
  return {
    issue: {
      issueId: "123",
      shortId: "CHECKOUT-431",
      title: "Payment confirmation timed out",
      projectId: "42",
      projectSlug: "checkout-api",
      status: "unresolved",
      substatus: "regressed",
      htmlUrl: "https://acme.sentry.io/issues/123/",
    },
    event: {
      eventId,
      issueId: "123",
      projectId: "42",
      environment: "production",
      title: "Payment confirmation timed out",
      observedAt: "2026-07-05T15:00:00.000Z",
    },
  }
}

function destination(hasOnCall = true): PagerDutyDestination {
  return {
    serviceId: "service-1",
    serviceName: "Checkout API",
    serviceUrl: "https://acme.pagerduty.com/service-directory/service-1",
    hasOnCall,
    priorities: [
      { severity: "sev1", priorityId: "priority-1", priorityName: "SEV-1" },
      { severity: "sev2", priorityId: "priority-2", priorityName: "SEV-2" },
      { severity: "sev3", priorityId: "priority-3", priorityName: "SEV-3" },
    ],
  }
}

function incident(priorityId = "priority-1"): PagerDutyIncident {
  return {
    incidentId: "incident-1",
    incidentNumber: 42,
    status: "triggered",
    incidentKey: "unused-by-view",
    serviceId: "service-1",
    priorityId,
    priorityName: priorityId === "priority-1" ? "SEV-1" : "SEV-2",
    htmlUrl: "https://acme.pagerduty.com/incidents/incident-1",
  }
}

function dependencies(
  overrides: {
    verifyEvent?: (
      issueId: string,
      eventId: string,
      options?: { deadlineAtMs?: number }
    ) => Promise<SentryInspection>
    inspectIssue?: () => Promise<SentryInspection>
    getDestination?: (options?: {
      deadlineAtMs?: number
    }) => Promise<PagerDutyDestination>
    findIncident?: (
      key: string,
      options?: {
        attempts?: number
        timeoutMs?: number
        deadlineAtMs?: number
      }
    ) => Promise<PagerDutyIncident | null>
    createIncident?: (
      input: {
        incidentKey: string
        priorityId: string
        title: string
        details: string
      },
      options?: { deadlineAtMs?: number }
    ) => Promise<{ incident: PagerDutyIncident; requestId: string | null }>
    sleep?: (milliseconds: number) => Promise<void>
    now?: () => number
  } = {}
) {
  return {
    sentry: {
      searchIssues: async () => ({ issues: [], hasMore: false }),
      inspectIssue: overrides.inspectIssue ?? (async () => inspection()),
      verifyEvent: overrides.verifyEvent ?? (async () => inspection()),
    },
    pagerDuty: {
      getDestination: overrides.getDestination ?? (async () => destination()),
      findIncident: overrides.findIncident ?? (async () => null),
      createIncident:
        overrides.createIncident ??
        (async () => ({ incident: incident(), requestId: "request-1" })),
    },
    sleep: overrides.sleep ?? (async () => undefined),
    now: overrides.now,
  }
}

test("inspection returns an understandable confirmation preview", async () => {
  const result = await inspectSentryIssue(
    "CHECKOUT-431",
    config(),
    dependencies()
  )
  assert.equal(result.status, "ready")
  assert.equal(result.issue?.shortId, "CHECKOUT-431")
  assert.equal(result.event?.eventId, "a".repeat(32))
  assert.equal(result.destination?.serviceName, "Checkout API")
  assert.deepEqual(
    result.destination?.priorities.map(({ severity, priorityName }) => ({
      severity,
      priorityName,
    })),
    [
      { severity: "sev1", priorityName: "SEV-1" },
      { severity: "sev2", priorityName: "SEV-2" },
      { severity: "sev3", priorityName: "SEV-3" },
    ]
  )
})

test("search reports empty and blocked reads without inventing candidates", async () => {
  const empty = await searchSentryIssues(null, null, config(), dependencies())
  assert.equal(empty.status, "completed")
  assert.deepEqual(empty.issues, [])
  assert.match(empty.message, /No matching/)

  const blockedDependencies = dependencies()
  blockedDependencies.sentry.searchIssues = async () => {
    throw new ProviderError("Sentry", "Sentry is unavailable.")
  }
  const blocked = await searchSentryIssues(
    "checkout",
    "1h",
    config(),
    blockedDependencies
  )
  assert.equal(blocked.status, "blocked")
  assert.deepEqual(blocked.issues, [])
  assert.equal(blocked.hasMore, false)
})

test("inspection returns an existing incident for the exact occurrence", async () => {
  let destinationReads = 0
  const result = await inspectSentryIssue(
    "CHECKOUT-431",
    config(),
    dependencies({
      findIncident: async () => incident(),
      getDestination: async () => {
        destinationReads += 1
        return destination()
      },
    })
  )
  assert.equal(result.status, "already_declared")
  assert.equal(result.existingIncident?.incidentNumber, 42)
  assert.equal(result.destination, null)
  assert.equal(destinationReads, 0)
  assert.match(result.message, /already has PagerDuty incident/)
})

test("inspection blocks declaration when the service has no on-call coverage", async () => {
  const result = await inspectSentryIssue(
    "CHECKOUT-431",
    config(),
    dependencies({ getDestination: async () => destination(false) })
  )
  assert.equal(result.status, "ineligible")
  assert.match(result.message, /no current on-call coverage/)
})

test("declaration re-verifies the event and sends one prioritized write", async () => {
  let writes = 0
  const calls: string[] = []
  const preflightDeadlines: Array<number | undefined> = []
  let writeDeadline: number | undefined
  const captured = {
    mutationInput: null as {
      incidentKey: string
      priorityId: string
      title: string
      details: string
    } | null,
  }
  const result = await declareProductionIncident(
    { issueId: "123", eventId: "a".repeat(32), severity: "sev1" },
    config(),
    dependencies({
      findIncident: async (_key, options) => {
        calls.push("find")
        preflightDeadlines.push(options?.deadlineAtMs)
        return null
      },
      getDestination: async (options) => {
        calls.push("destination")
        preflightDeadlines.push(options?.deadlineAtMs)
        return destination()
      },
      verifyEvent: async (_issueId, _eventId, options) => {
        calls.push("verify")
        preflightDeadlines.push(options?.deadlineAtMs)
        return inspection()
      },
      createIncident: async (input, options) => {
        calls.push("create")
        writeDeadline = options?.deadlineAtMs
        writes += 1
        captured.mutationInput = input
        return { incident: incident(), requestId: "request-1" }
      },
    })
  )
  assert.equal(result.status, "declared")
  assert.equal(result.changed, true)
  assert.equal(writes, 1)
  assert.equal(captured.mutationInput?.priorityId, "priority-1")
  assert.match(captured.mutationInput?.title ?? "", /^\[SEV-1\] CHECKOUT-431:/)
  assert.match(captured.mutationInput?.details ?? "", /Event ID: a{32}/)
  assert.deepEqual(calls, ["find", "destination", "verify", "create"])
  assert.ok(preflightDeadlines.every((deadline) => deadline !== undefined))
  assert.equal(new Set(preflightDeadlines).size, 1)
  assert.ok(
    writeDeadline !== undefined &&
      writeDeadline > (preflightDeadlines[0] ?? Number.POSITIVE_INFINITY)
  )
})

test("a stale or resolved Sentry issue sends no PagerDuty write", async () => {
  let writes = 0
  const result = await declareProductionIncident(
    { issueId: "123", eventId: "a".repeat(32), severity: "sev1" },
    config(),
    dependencies({
      verifyEvent: async () => {
        throw new SentryStateError(
          "The Sentry issue is no longer unresolved.",
          "conflict"
        )
      },
      createIncident: async () => {
        writes += 1
        return { incident: incident(), requestId: null }
      },
    })
  )
  assert.equal(result.status, "conflict")
  assert.equal(result.changed, false)
  assert.equal(writes, 0)
})

test("an existing exact incident is a no-op", async () => {
  let writes = 0
  let mutableChecks = 0
  const result = await declareProductionIncident(
    { issueId: "123", eventId: "a".repeat(32), severity: "sev1" },
    config(),
    dependencies({
      findIncident: async () => incident(),
      getDestination: async () => {
        mutableChecks += 1
        return destination(false)
      },
      verifyEvent: async () => {
        mutableChecks += 1
        throw new SentryStateError(
          "The Sentry issue is no longer unresolved.",
          "conflict"
        )
      },
      createIncident: async () => {
        writes += 1
        return { incident: incident(), requestId: null }
      },
    })
  )
  assert.equal(result.status, "already_declared")
  assert.equal(result.changed, false)
  assert.equal(result.incident?.incidentNumber, 42)
  assert.equal(result.source, null)
  assert.equal(mutableChecks, 0)
  assert.equal(writes, 0)
})

test("an existing incident with another priority is a conflict", async () => {
  let mutableChecks = 0
  const result = await declareProductionIncident(
    { issueId: "123", eventId: "a".repeat(32), severity: "sev1" },
    config(),
    dependencies({
      findIncident: async () => incident("priority-2"),
      getDestination: async () => {
        mutableChecks += 1
        return destination(false)
      },
      verifyEvent: async () => {
        mutableChecks += 1
        throw new SentryStateError(
          "The Sentry issue is no longer unresolved.",
          "conflict"
        )
      },
    })
  )
  assert.equal(result.status, "conflict")
  assert.equal(result.changed, false)
  assert.equal(result.source, null)
  assert.equal(mutableChecks, 0)
  assert.match(result.message, /different PagerDuty priority/)
})

test("a lost response reconciles without retrying the write", async () => {
  let writes = 0
  let reads = 0
  const delays: number[] = []
  const readOptions: Array<
    | {
        attempts?: number
        timeoutMs?: number
        deadlineAtMs?: number
      }
    | undefined
  > = []
  const result = await declareProductionIncident(
    { issueId: "123", eventId: "a".repeat(32), severity: "sev1" },
    config(),
    dependencies({
      findIncident: async (_key, options) => {
        reads += 1
        readOptions.push(options)
        return reads >= 3 ? incident() : null
      },
      createIncident: async () => {
        writes += 1
        throw new ProviderError("PagerDuty", "response lost", {
          requestId: "request-ambiguous",
          mutationOutcome: "unknown",
        })
      },
      sleep: async (milliseconds) => {
        delays.push(milliseconds)
      },
    })
  )
  assert.equal(result.status, "declared")
  assert.equal(result.changed, null)
  assert.equal(result.incident?.incidentNumber, 42)
  assert.equal(result.requestId, "request-ambiguous")
  assert.equal(writes, 1)
  assert.deepEqual(delays, [500])
  assert.equal(readOptions.length, 3)
  assert.deepEqual(
    readOptions.map((options) => ({
      attempts: options?.attempts,
      timeoutMs: options?.timeoutMs,
    })),
    [
      { attempts: undefined, timeoutMs: undefined },
      { attempts: 1, timeoutMs: 3_000 },
      { attempts: 1, timeoutMs: 3_000 },
    ]
  )
  assert.ok(readOptions.every((options) => options?.deadlineAtMs !== undefined))
})

test("an unproven write remains ambiguous with null causality", async () => {
  let writes = 0
  let reads = 0
  const result = await declareProductionIncident(
    { issueId: "123", eventId: "a".repeat(32), severity: "sev1" },
    config(),
    dependencies({
      findIncident: async () => {
        reads += 1
        return null
      },
      createIncident: async () => {
        writes += 1
        throw new ProviderError("PagerDuty", "response lost", {
          mutationOutcome: "unknown",
        })
      },
    })
  )
  assert.equal(result.status, "ambiguous")
  assert.equal(result.changed, null)
  assert.equal(result.incident, null)
  assert.equal(writes, 1)
  assert.equal(reads, 4)
})

test("ambiguous reconciliation does not violate PagerDuty Retry-After", async () => {
  let reads = 0
  const delays: number[] = []
  const result = await declareProductionIncident(
    { issueId: "123", eventId: "a".repeat(32), severity: "sev1" },
    config(),
    dependencies({
      findIncident: async () => {
        reads += 1
        if (reads === 1) return null
        throw new ProviderError("PagerDuty", "rate limited", {
          status: 429,
          retryable: true,
          retryAfterSeconds: 10,
        })
      },
      createIncident: async () => {
        throw new ProviderError("PagerDuty", "response lost", {
          mutationOutcome: "unknown",
        })
      },
      sleep: async (milliseconds) => {
        delays.push(milliseconds)
      },
    })
  )
  assert.equal(result.status, "ambiguous")
  assert.equal(result.changed, null)
  assert.equal(reads, 2)
  assert.deepEqual(delays, [])
})

test("ambiguous reconciliation does not retry non-retryable reads", async () => {
  let reads = 0
  const result = await declareProductionIncident(
    { issueId: "123", eventId: "a".repeat(32), severity: "sev1" },
    config(),
    dependencies({
      findIncident: async () => {
        reads += 1
        if (reads === 1) return null
        throw new ProviderError("PagerDuty", "PagerDuty returned HTTP 403.", {
          status: 403,
        })
      },
      createIncident: async () => {
        throw new ProviderError("PagerDuty", "response lost", {
          mutationOutcome: "unknown",
        })
      },
    })
  )
  assert.equal(result.status, "ambiguous")
  assert.equal(result.changed, null)
  assert.equal(reads, 2)
})

test("provider identity is stable across mutable Sentry configuration", () => {
  const identity = { issueId: "123", eventId: "a".repeat(32) }
  const first = incidentKey(config(), identity)
  const renamed = incidentKey(
    {
      ...config(),
      sentryOrgSlug: "renamed-org",
      sentryProjectSlug: "renamed-project",
      sentryEnvironment: "renamed-environment",
      sentryBaseUrl: "https://us.sentry.io",
    },
    { ...identity, eventId: identity.eventId.toUpperCase() }
  )
  const second = incidentKey(config(), {
    ...identity,
    eventId: "b".repeat(32),
  })
  const anotherService = incidentKey(
    { ...config(), pagerDutyServiceId: "service-2" },
    identity
  )
  const anotherIssue = incidentKey(config(), {
    ...identity,
    issueId: "456",
  })
  assert.equal(first, renamed)
  assert.notEqual(first, second)
  assert.notEqual(first, anotherService)
  assert.notEqual(first, anotherIssue)
  assert.match(first, /^notion-sentry-[0-9a-f]{48}$/)
})

test("an expired safety-check budget prevents a PagerDuty write", async () => {
  let currentTime = 0
  let verifications = 0
  let writes = 0
  const result = await declareProductionIncident(
    { issueId: "123", eventId: "a".repeat(32), severity: "sev1" },
    config(),
    dependencies({
      now: () => currentTime,
      getDestination: async () => {
        currentTime = 100_000
        return destination()
      },
      verifyEvent: async () => {
        verifications += 1
        return inspection()
      },
      createIncident: async () => {
        writes += 1
        return { incident: incident(), requestId: null }
      },
    })
  )
  assert.equal(result.status, "blocked")
  assert.equal(result.changed, false)
  assert.equal(verifications, 0)
  assert.equal(writes, 0)
  assert.match(result.message, /did not finish in time/)
})

test("a final Sentry check that exhausts the budget prevents the write", async () => {
  let currentTime = 0
  let writes = 0
  const result = await declareProductionIncident(
    { issueId: "123", eventId: "a".repeat(32), severity: "sev1" },
    config(),
    dependencies({
      now: () => currentTime,
      verifyEvent: async () => {
        currentTime = 100_000
        return inspection()
      },
      createIncident: async () => {
        writes += 1
        return { incident: incident(), requestId: null }
      },
    })
  )
  assert.equal(result.status, "blocked")
  assert.equal(result.changed, false)
  assert.equal(result.source?.eventId, "a".repeat(32))
  assert.equal(writes, 0)
  assert.match(result.message, /final Sentry check/)
})

test("unexpected programming errors remain visible", async () => {
  const unexpected = new Error("bug")
  await assert.rejects(
    () =>
      declareProductionIncident(
        { issueId: "123", eventId: "a".repeat(32), severity: "sev1" },
        config(),
        dependencies({
          verifyEvent: async () => {
            throw unexpected
          },
        })
      ),
    (error: unknown) => error === unexpected
  )
})
