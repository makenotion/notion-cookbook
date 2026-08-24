// Offline regression tests for the Sentry sync Worker.
// Run from this directory with `npm test`.

import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { RateLimitError } from "@notionhq/workers"

import {
  escapeMarkdown,
  formatSentryLabel,
  nonnegativeNumber,
  safeHttpUrl,
  selectText,
  summedStats,
  titleText,
} from "./src/helpers.js"
import worker, {
  executeIssuesSync,
  executeProjectsSync,
  executeReleasesSync,
  type ProjectSyncState,
} from "./src/index.js"
import { issuePageContent, issueToChange } from "./src/issues.js"
import {
  aggregateProjectIssues,
  projectToChange,
  type ProjectIssueAggregate,
} from "./src/projects.js"
import {
  RELEASE_HEALTH_DAYS,
  releaseHealthWindow,
  releasesToChanges,
  sentryReleaseUrl,
} from "./src/releases.js"
import {
  buildIssuesUrl,
  buildProjectsUrl,
  buildReleaseHealthUrl,
  buildReleasesUrl,
  fetchIssuesPage,
  fetchProjectsPage,
  fetchRecentReleases,
  fetchReleaseHealth,
  getSentryScope,
  nextCursorFromLink,
  parseRetryAfterSeconds,
  rateLimitRetryAfterSeconds,
  type SentryIssue,
  type SentryProject,
  type SentryRelease,
  type SentryReleaseHealthSnapshot,
  type SentryScope,
} from "./src/sentry.js"
import {
  ISSUE_WINDOW_DAYS,
  MAX_RECENT_CURSOR_FINGERPRINTS,
  MAX_SAFE_SYNC_STATE_LENGTH,
  boundedSyncState,
  issueWindow,
  nextCursorTraversal,
  nextIssueState,
  syncStateSize,
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

const defaultScope: SentryScope = {
  baseUrl: "https://sentry.io/",
  organization: "acme",
  projects: [],
  environments: [],
}

const fullProject: SentryProject = {
  id: "99",
  name: "Checkout API",
  slug: "checkout-api",
  platform: "node",
  platforms: ["node"],
  teams: [{ id: "7", name: "Checkout", slug: "checkout" }],
  dateCreated: "2025-01-01T00:00:00.000Z",
  firstEvent: "2025-01-02T00:00:00.000Z",
  hasSessions: true,
}

function projectAggregate(projectId: string): ProjectIssueAggregate {
  return aggregateProjectIssues(
    {},
    [
      {
        ...fullIssue,
        id: `issue-${projectId}`,
        project: {
          ...fullIssue.project!,
          id: projectId,
          name: `Project ${projectId}`,
          slug: `project-${projectId}`,
        },
        stats: {
          "14d": [[Date.parse("2026-07-01T15:00:00.000Z") / 1_000, 1]],
        },
      },
    ],
    {
      start: "2026-06-02T15:00:00.000Z",
      end: "2026-07-02T15:00:00.000Z",
    }
  )[projectId]
}

const fullRelease: SentryRelease = {
  id: "501",
  version: "checkout@2.4.0",
  shortVersion: "2.4.0",
  status: "open",
  ref: "abcdef123",
  url: "https://github.com/acme/checkout/releases/tag/2.4.0",
  dateReleased: "2026-07-01T12:00:00.000Z",
  dateCreated: "2026-07-01T11:00:00.000Z",
  newGroups: 3,
  commitCount: 12,
  deployCount: 2,
  firstEvent: "2026-07-01T12:01:00.000Z",
  lastEvent: "2026-07-02T14:00:00.000Z",
  projects: [
    {
      id: "99",
      name: "Checkout API",
      slug: "checkout-api",
      newGroups: 3,
      platform: "node",
      platforms: ["node"],
      hasHealthData: true,
    },
  ],
}

const fullReleaseHealth: SentryReleaseHealthSnapshot = {
  start: "2026-06-25T00:00:00.000Z",
  end: "2026-07-02T00:00:00.000Z",
  groups: [
    {
      release: "checkout@2.4.0",
      sessions: 12_000,
      users: 4_000,
      crashFreeSessions: 99.95,
      crashFreeUsers: 99.5,
    },
  ],
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

function rawProject(overrides: Record<string, unknown> = {}) {
  return {
    id: fullProject.id,
    name: fullProject.name,
    slug: fullProject.slug,
    platform: fullProject.platform,
    platforms: fullProject.platforms,
    teams: fullProject.teams,
    dateCreated: fullProject.dateCreated,
    firstEvent: fullProject.firstEvent,
    hasSessions: fullProject.hasSessions,
    access: ["project:read"],
    features: ["releases"],
    ...overrides,
  }
}

function rawRelease(overrides: Record<string, unknown> = {}) {
  return {
    id: Number(fullRelease.id),
    version: fullRelease.version,
    shortVersion: fullRelease.shortVersion,
    status: fullRelease.status,
    ref: fullRelease.ref,
    url: fullRelease.url,
    dateReleased: fullRelease.dateReleased,
    dateCreated: fullRelease.dateCreated,
    newGroups: fullRelease.newGroups,
    commitCount: fullRelease.commitCount,
    deployCount: fullRelease.deployCount,
    firstEvent: fullRelease.firstEvent,
    lastEvent: fullRelease.lastEvent,
    projects: fullRelease.projects.map((project) => ({
      ...project,
      id: Number(project.id),
    })),
    authors: [{ id: "person", email: "private@example.com" }],
    data: { sensitive: true },
    ...overrides,
  }
}

test("manifest enables all three databases by default", () => {
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
        title: "Sentry Issues",
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
      {
        key: "projects",
        title: "Sentry Projects",
        primaryKey: "Sentry Project ID",
        icon: { type: "notion", icon: "chart-line", color: "gray" },
        firstSix: [
          "Project",
          "Unresolved Issues (30d)",
          "Events (7d)",
          "Most Active Issue (7d)",
          "Issue Link",
          "Last Seen",
        ],
      },
      {
        key: "releases",
        title: "Sentry Releases",
        primaryKey: "Sentry Release ID",
        icon: { type: "notion", icon: "shield", color: "gray" },
        firstSix: [
          "Release",
          "Projects",
          "Crash-Free Users",
          "Crash-Free Sessions",
          "New Issues",
          "Status",
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
      {
        key: "projectsSync",
        databaseKey: "projects",
        mode: "replace",
        schedule: { type: "interval", intervalMs: 24 * 60 * 60_000 },
      },
      {
        key: "releasesSync",
        databaseKey: "releases",
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

test("issue transform clears values that disappear without inventing false values", () => {
  const populated = issueToChange(fullIssue).properties as Record<
    string,
    unknown
  >
  const change = issueToChange({ ...minimalIssue, id: fullIssue.id })
  const properties = change.properties as Record<string, unknown>
  const clearableProperties = [
    "Status",
    "Assignee",
    "Issue Link",
    "Last Seen",
    "Priority",
    "Status Detail",
    "Level",
    "Unhandled",
    "Events (24h)",
    "Events (30d)",
    "Users (30d)",
    "Lifetime Events",
    "Lifetime Users",
    "Project",
    "Category",
    "Issue Type",
    "Platform",
    "Culprit",
    "First Seen",
    "Issue Key",
  ]
  for (const property of clearableProperties) {
    assert.notDeepEqual(populated[property], [], `${property} starts populated`)
    assert.deepEqual(
      properties[property],
      [],
      `${property} is explicitly cleared`
    )
  }
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

test("project aggregation answers service-risk questions without double-counting users", () => {
  const window = {
    start: "2026-06-02T15:00:00.000Z",
    end: "2026-07-02T15:00:00.000Z",
  }
  const previous = Date.parse("2026-06-24T15:00:00.000Z") / 1_000
  const current = Date.parse("2026-07-01T15:00:00.000Z") / 1_000
  const aggregates = aggregateProjectIssues(
    {},
    [
      {
        ...fullIssue,
        count: 100,
        userCount: 80,
        stats: {
          "14d": [
            [previous, 4],
            [current, 10],
          ],
        },
      },
      {
        ...fullIssue,
        id: "4500000000000003",
        title: "Resolved checkout warning",
        status: "resolved",
        substatus: null,
        priority: "low",
        isUnhandled: false,
        assignedTo: null,
        count: 50,
        userCount: 80,
        stats: {
          "14d": [
            [previous, 6],
            [current, 5],
          ],
        },
      },
    ],
    window
  )

  const aggregate = aggregates["99"]
  assert.equal(aggregate.issueGroups, 2)
  assert.equal(aggregate.unresolvedIssues, 1)
  assert.equal(aggregate.highPriorityUnresolved, 1)
  assert.equal(aggregate.regressedUnresolved, 1)
  assert.equal(aggregate.unassignedUnresolved, 0)
  assert.equal(aggregate.previous7dEvents, 10)
  assert.equal(aggregate.events7d, 15)
  assert.equal(aggregate.events30d, 150)
  assert.equal(aggregate.mostActiveIssue?.id, fullIssue.id)
  assert.equal("users" in aggregate, false)

  const change = projectToChange(
    fullProject,
    aggregate,
    window.end,
    defaultScope
  )
  const properties = change.properties as Record<string, unknown>
  assert.deepEqual(Object.keys(properties).slice(0, 6), [
    "Project",
    "Unresolved Issues (30d)",
    "Events (7d)",
    "Most Active Issue (7d)",
    "Issue Link",
    "Last Seen",
  ])
  assertPropertyContains(properties["Events (7d)"], "15")
  assertPropertyContains(properties["Previous 7d Events"], "10")
  assertPropertyContains(properties["Event Change vs Prior 7d"], "5")
  assertPropertyContains(properties["Environment Scope"], "All environments")
  assert.equal(properties["Users (30d)"], undefined)
  assert.match(change.pageContentMarkdown, /Ownership gaps/)
})

test("project event buckets use exact boundaries and clear incomplete totals", () => {
  const window = {
    start: "2026-06-02T15:00:00.000Z",
    end: "2026-07-02T15:00:00.000Z",
  }
  const start14d = Date.parse("2026-06-18T15:00:00.000Z") / 1_000
  const split7d = Date.parse("2026-06-25T15:00:00.000Z") / 1_000
  const end = Date.parse(window.end) / 1_000
  const complete = aggregateProjectIssues(
    {},
    [
      {
        ...fullIssue,
        stats: {
          "14d": [
            [start14d, 2],
            [split7d, 3],
            [end, 5],
          ],
        },
      },
    ],
    window
  )["99"]
  assert.equal(complete.previous7dEvents, 2)
  assert.equal(complete.events7d, 8)
  const completeProperties = projectToChange(
    fullProject,
    complete,
    window.end,
    defaultScope
  ).properties as Record<string, unknown>

  const incomplete = aggregateProjectIssues(
    {},
    [{ ...fullIssue, stats: null, count: null }],
    window
  )["99"]
  const change = projectToChange(
    fullProject,
    incomplete,
    window.end,
    defaultScope
  )
  const properties = change.properties as Record<string, unknown>
  for (const property of [
    "Events (7d)",
    "Previous 7d Events",
    "Event Change vs Prior 7d",
    "Events (30d)",
    "Most Active Issue (7d)",
    "Issue Link",
  ]) {
    assert.notDeepEqual(
      completeProperties[property],
      [],
      `${property} starts populated`
    )
    assert.deepEqual(
      properties[property],
      [],
      `${property} is explicitly cleared`
    )
  }
})

test("project aggregation requires immutable IDs and tolerates project renames", () => {
  const window = {
    start: "2026-06-02T15:00:00.000Z",
    end: "2026-07-02T15:00:00.000Z",
  }
  assert.throws(
    () =>
      aggregateProjectIssues(
        {},
        [{ ...fullIssue, project: { ...fullIssue.project!, id: null } }],
        window
      ),
    /immutable project ID/
  )
  const firstPage = aggregateProjectIssues({}, [fullIssue], window)
  const renamedProject = {
    ...fullProject,
    name: "Checkout Platform",
    slug: "checkout-platform",
  }
  const secondPage = aggregateProjectIssues(
    firstPage,
    [
      {
        ...fullIssue,
        id: "different-issue",
        project: {
          ...fullIssue.project!,
          name: renamedProject.name,
          slug: renamedProject.slug,
        },
      },
    ],
    window
  )
  assert.deepEqual(Object.keys(secondPage), ["99"])
  assert.equal(secondPage["99"].issueGroups, 2)

  const change = projectToChange(
    renamedProject,
    secondPage["99"],
    window.end,
    defaultScope
  )
  assert.equal(change.key, "99")
  assertPropertyContains(change.properties.Project, "Checkout Platform")
  assertPropertyContains(change.properties["Project Slug"], "checkout-platform")
})

test("release transform combines metadata and aggregate health with stable identity", () => {
  const changes = releasesToChanges(
    [fullRelease],
    fullReleaseHealth,
    defaultScope
  )
  assert.equal(changes.length, 1)
  const change = changes[0]
  const properties = change.properties as Record<string, unknown>
  assert.equal(change.key, "501")
  assert.deepEqual(Object.keys(properties).slice(0, 6), [
    "Release",
    "Projects",
    "Crash-Free Users",
    "Crash-Free Sessions",
    "New Issues",
    "Status",
  ])
  assertPropertyContains(properties["Crash-Free Sessions"], "0.9995")
  assertPropertyContains(properties["Crash-Free Users"], "0.995")
  assertPropertyContains(properties["Sessions (7d)"], "12000")
  assertPropertyContains(properties["New Issues"], "3")
  assert.match(
    change.pageContentMarkdown,
    /2026-06-25T00:00:00.000Z to 2026-07-02T00:00:00.000Z/
  )
  assertPropertyContains(
    properties["Health Project Scope"],
    "All accessible projects"
  )
  assertPropertyContains(properties["Environment Scope"], "All environments")
  assert.doesNotMatch(change.pageContentMarkdown, /private@example\.com/)
})

test("release rows remain useful when health is absent and preserve explicit zeroes", () => {
  const populatedProperties = releasesToChanges(
    [fullRelease],
    fullReleaseHealth,
    defaultScope
  )[0].properties as Record<string, unknown>
  const noHealth = releasesToChanges(
    [
      {
        ...fullRelease,
        newGroups: 0,
        projects: [
          {
            ...fullRelease.projects[0],
            hasHealthData: false,
            newGroups: 0,
          },
        ],
      },
    ],
    { ...fullReleaseHealth, groups: [] },
    defaultScope
  )[0]
  const noHealthProperties = noHealth.properties as Record<string, unknown>
  assertPropertyContains(noHealthProperties["Health Data (7d)"], "No")
  assertPropertyContains(noHealthProperties["New Issues"], "0")
  for (const property of [
    "Crash-Free Users",
    "Crash-Free Sessions",
    "Sessions (7d)",
    "Users (7d)",
  ]) {
    assert.notDeepEqual(
      populatedProperties[property],
      [],
      `${property} starts populated`
    )
    assert.deepEqual(
      noHealthProperties[property],
      [],
      `${property} is explicitly cleared`
    )
  }

  const zeroHealth = releasesToChanges(
    [fullRelease],
    {
      ...fullReleaseHealth,
      groups: [
        {
          ...fullReleaseHealth.groups[0],
          sessions: 0,
          users: 0,
          crashFreeSessions: 0,
          crashFreeUsers: 0,
        },
      ],
    },
    defaultScope
  )[0].properties as Record<string, unknown>
  assertPropertyContains(zeroHealth["Sessions (7d)"], "0")
  assertPropertyContains(zeroHealth["Crash-Free Sessions"], "0")
})

test("release links encode opaque versions and crash-free percentages are bounded", () => {
  const link = sentryReleaseUrl(defaultScope, "mobile/1.0 @ 日本?")
  assert.match(link, /mobile%2F1\.0%20%40%20%E6%97%A5%E6%9C%AC%3F/)
  const parenthesized = releasesToChanges(
    [{ ...fullRelease, version: "mobile)1.0" }],
    { ...fullReleaseHealth, groups: [] },
    defaultScope
  )[0]
  assert.match(parenthesized.pageContentMarkdown, /mobile%291\.0/)
  assert.throws(
    () =>
      releasesToChanges(
        [fullRelease],
        {
          ...fullReleaseHealth,
          groups: [{ ...fullReleaseHealth.groups[0], crashFreeSessions: 101 }],
        },
        defaultScope
      ),
    /invalid crash-free percentage/
  )
  assert.throws(
    () =>
      releasesToChanges(
        [
          {
            ...fullRelease,
            projects: Array.from({ length: 101 }, (_, index) => ({
              ...fullRelease.projects[0],
              id: String(index),
              name: `Project ${index}`,
              slug: `project-${index}`,
            })),
          },
        ],
        fullReleaseHealth,
        defaultScope
      ),
    /more than 100 projects/
  )
})

test("a project with no recent issues remains visible with truthful zeroes", () => {
  const change = projectToChange(
    fullProject,
    undefined,
    "2026-07-02T15:00:00.000Z",
    defaultScope
  )
  const properties = change.properties as Record<string, unknown>
  assertPropertyContains(properties["Unresolved Issues (30d)"], "0")
  assertPropertyContains(properties["Events (7d)"], "0")
  assertPropertyContains(properties["Issue Groups (30d)"], "0")
  assertPropertyContains(properties["Events (30d)"], "0")
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
  assert.equal(
    Array.from(titleText("x".repeat(3_000), "Fallback title")).length,
    2_000
  )
  assert.equal(
    titleText("  ", "Untitled Sentry project"),
    "Untitled Sentry project"
  )
})

test("resource transforms use resource-specific fallback titles", () => {
  const issueProperties = issueToChange({
    ...minimalIssue,
    title: " ",
  }).properties as Record<string, unknown>
  assertPropertyContains(issueProperties.Issue, "Untitled Sentry issue")

  const projectProperties = projectToChange(
    { ...fullProject, name: " " },
    undefined,
    "2026-07-02T15:00:00.000Z",
    defaultScope
  ).properties as Record<string, unknown>
  assertPropertyContains(projectProperties.Project, "Untitled Sentry project")

  const releaseProperties = releasesToChanges(
    [{ ...fullRelease, shortVersion: " " }],
    fullReleaseHealth,
    defaultScope
  )[0].properties as Record<string, unknown>
  assertPropertyContains(releaseProperties.Release, "Untitled Sentry release")
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

test("continuation state keeps headroom below the Workers runtime limit", () => {
  assert.ok(MAX_SAFE_SYNC_STATE_LENGTH < 256 * 1024)
  assert.deepEqual(boundedSyncState({ cursor: "small" }, "test"), {
    cursor: "small",
  })
  assert.throws(
    () =>
      boundedSyncState(
        { data: "x".repeat(MAX_SAFE_SYNC_STATE_LENGTH) },
        "test"
      ),
    /240 KiB safety budget.*cannot continue safely/
  )
})

test("release health window is exactly seven days", () => {
  const now = Date.parse("2026-07-02T15:00:00.000Z")
  const window = releaseHealthWindow(now)
  assert.equal(
    Date.parse(window.end) - Date.parse(window.start),
    RELEASE_HEALTH_DAYS * 86_400_000
  )
  assert.throws(() => releaseHealthWindow(Number.NaN), /invalid time/)
})

test("cursor state catches immediate and longer pagination loops", () => {
  const window = {
    start: "2026-06-02T15:00:00.000Z",
    end: "2026-07-02T15:00:00.000Z",
  }
  const first = nextIssueState(undefined, window, defaultScope, "cursor-a")
  const second = nextIssueState(first, window, defaultScope, "cursor-b")

  assert.equal(first.cursor, "cursor-a")
  assert.equal(second.seenCursors?.length, 2)
  assert.ok(second.seenCursors?.every((cursor) => cursor.startsWith("h:")))
  assert.equal(second.seenCursors?.includes("cursor-a"), false)
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
  assert.throws(
    () =>
      nextCursorTraversal(
        "project-b",
        ["project-a", "project-b"],
        "project-a",
        "project"
      ),
    /project pagination repeated/
  )
})

test("cursor history stays compact without imposing a page limit", () => {
  let cursor: string | undefined
  let seenCursors: string[] | undefined
  for (let index = 0; index < 2_000; index += 1) {
    const traversal = nextCursorTraversal(
      cursor,
      seenCursors,
      `cursor-${index}`,
      "test"
    )
    cursor = traversal.cursor
    seenCursors = traversal.seenCursors
  }
  assert.equal(seenCursors?.length, MAX_RECENT_CURSOR_FINGERPRINTS)
  assert.ok(syncStateSize({ cursor, seenCursors }) < 2 * 1024)
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

  const projectHealthUrl = buildIssuesUrl({
    start: "2026-06-02T15:00:00.000Z",
    end: "2026-07-02T15:00:00.000Z",
    statsPeriod: "14d",
  })
  assert.equal(projectHealthUrl.searchParams.get("groupStatsPeriod"), "14d")
})

test("project and release URLs are bounded and carry the configured scope", () => {
  configureEnvironment()
  process.env.SENTRY_PROJECTS = "checkout-api,99"
  process.env.SENTRY_ENVIRONMENTS = "production,staging"

  const projects = buildProjectsUrl("project:100:0")
  assert.equal(projects.pathname, "/api/0/organizations/acme/projects/")
  assert.equal(projects.searchParams.get("per_page"), "100")
  assert.equal(projects.searchParams.get("cursor"), "project:100:0")

  const releases = buildReleasesUrl()
  assert.equal(releases.pathname, "/api/0/organizations/acme/releases/")
  assert.equal(releases.searchParams.get("per_page"), "100")
  assert.equal(releases.searchParams.has("status"), false)
  assert.deepEqual(releases.searchParams.getAll("project"), [
    "checkout-api",
    "99",
  ])
  assert.deepEqual(releases.searchParams.getAll("environment"), [
    "production",
    "staging",
  ])
  assert.equal(releases.searchParams.has("cursor"), false)

  const health = buildReleaseHealthUrl(
    "2026-06-25T15:00:00.000Z",
    "2026-07-02T15:00:00.000Z"
  )
  assert.equal(health.pathname, "/api/0/organizations/acme/sessions/")
  assert.deepEqual(health.searchParams.getAll("field"), [
    "sum(session)",
    "count_unique(user)",
    "crash_free_rate(session)",
    "crash_free_rate(user)",
  ])
  assert.deepEqual(health.searchParams.getAll("groupBy"), ["release"])
  assert.equal(health.searchParams.get("includeSeries"), "0")
  assert.equal(health.searchParams.get("per_page"), "250")
  assert.deepEqual(health.searchParams.getAll("project"), [
    "checkout-api",
    "99",
  ])
  assert.deepEqual(health.searchParams.getAll("environment"), [
    "production",
    "staging",
  ])
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

test("project and release clients retain selected fields and pace every request", async () => {
  configureEnvironment()
  let waits = 0
  const urls: URL[] = []
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    urls.push(url)
    if (url.pathname.endsWith("/projects/")) {
      return new Response(JSON.stringify([rawProject()]), {
        status: 200,
        headers: { Link: terminalLink(url) },
      })
    }
    if (url.pathname.endsWith("/releases/")) {
      return new Response(JSON.stringify([rawRelease()]), { status: 200 })
    }
    if (url.pathname.endsWith("/sessions/")) {
      return new Response(
        JSON.stringify({
          start: fullReleaseHealth.start,
          end: fullReleaseHealth.end,
          intervals: [],
          query: "",
          groups: [
            {
              by: { project: 99, release: fullRelease.version },
              totals: {
                "sum(session)": 12_000,
                "count_unique(user)": 4_000,
                "crash_free_rate(session)": 99.95,
                "crash_free_rate(user)": 99.5,
              },
              series: {},
              ignored: "not retained",
            },
          ],
        }),
        { status: 200 }
      )
    }
    throw new Error(`unexpected request ${url}`)
  }) as typeof fetch
  const wait = async () => {
    waits += 1
  }

  const projectPage = await fetchProjectsPage(wait, undefined)
  const releases = await fetchRecentReleases(wait)
  const health = await fetchReleaseHealth(
    wait,
    fullReleaseHealth.start!,
    fullReleaseHealth.end!
  )

  assert.equal(waits, 3)
  assert.equal(urls.length, 3)
  assert.equal(projectPage.resources[0].teams[0].name, "Checkout")
  assert.equal("access" in projectPage.resources[0], false)
  assert.equal(releases[0].id, "501")
  assert.equal(releases[0].projects[0].id, "99")
  assert.equal("authors" in releases[0], false)
  assert.equal("data" in releases[0], false)
  assert.deepEqual(health, fullReleaseHealth)
})

test("release client accepts documented name-and-slug-only project references", async () => {
  configureEnvironment()
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([
        rawRelease({
          projects: [{ name: "Checkout API", slug: "checkout-api" }],
        }),
      ]),
      { status: 200 }
    )) as typeof fetch

  const releases = await fetchRecentReleases(async () => undefined)
  assert.equal(releases[0].projects[0].id, null)
  assert.equal(releases[0].projects[0].name, "Checkout API")
})

test("new clients fail closed on malformed identity, shape, and health truncation", async () => {
  configureEnvironment()

  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    return new Response(JSON.stringify([rawProject({ id: null })]), {
      status: 200,
      headers: { Link: terminalLink(new URL(request.url)) },
    })
  }) as typeof fetch
  await assert.rejects(
    fetchProjectsPage(async () => undefined, undefined),
    /immutable id/
  )

  globalThis.fetch = (async () =>
    new Response(JSON.stringify([rawRelease({ projects: undefined })]), {
      status: 200,
    })) as typeof fetch
  await assert.rejects(
    fetchRecentReleases(async () => undefined),
    /projects/
  )

  const groups = Array.from({ length: 250 }, (_, index) => ({
    by: { project: index + 1, release: `release-${index}` },
    totals: { "sum(session)": 1 },
    series: {},
  }))
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        start: fullReleaseHealth.start,
        end: fullReleaseHealth.end,
        groups,
      }),
      { status: 200 }
    )) as typeof fetch
  await assert.rejects(
    fetchReleaseHealth(
      async () => undefined,
      fullReleaseHealth.start!,
      fullReleaseHealth.end!
    ),
    /250-group safety limit/
  )

  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    return new Response(
      JSON.stringify({
        start: fullReleaseHealth.start,
        end: fullReleaseHealth.end,
        groups: [
          {
            by: { release: "checkout@2.4.0" },
            totals: { "sum(session)": 1 },
            series: {},
          },
        ],
      }),
      {
        status: 200,
        headers: { Link: nextLink(new URL(request.url), "health-page-2") },
      }
    )
  }) as typeof fetch
  await assert.rejects(
    fetchReleaseHealth(
      async () => undefined,
      fullReleaseHealth.start!,
      fullReleaseHealth.end!
    ),
    /returned another page/
  )
})

test("API client uses a rotated credential without pinning stale auth state", async () => {
  configureEnvironment()
  const scope = getSentryScope()
  process.env.SENTRY_AUTH_TOKEN = "rotated-token-with-different-access"
  let authorization: string | null = null
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    authorization = request.headers.get("authorization")
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { Link: terminalLink(new URL(request.url)) },
    })
  }) as typeof fetch

  await fetchIssuesPage(
    async () => undefined,
    {
      start: "2026-06-02T15:00:00.000Z",
      end: "2026-07-02T15:00:00.000Z",
    },
    scope
  )
  assert.equal(authorization, "Bearer rotated-token-with-different-access")
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

const noPacing = async () => undefined

test("issues sync pins its 30-day window and advances opaque cursor state", async () => {
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

  const first = await executeIssuesSync(undefined, noPacing)

  assert.equal(first.hasMore, true)
  assert.equal(first.changes.length, 1)
  assert.equal(first.changes[0].key, fullIssue.id)
  assert.equal(first.nextState?.cursor, "cursor-page-2")
  assert.deepEqual(first.nextState?.scope.projects, ["checkout-api"])
  assert.deepEqual(first.nextState?.scope.environments, ["production"])
  assert.equal(
    Date.parse(first.nextState?.end ?? "") -
      Date.parse(first.nextState?.start ?? ""),
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

  const second = await executeIssuesSync(first.nextState, noPacing)

  assert.equal(second.hasMore, false)
  assert.equal(second.nextState, undefined)
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

test("projects Worker aggregates all issues before emitting enriched project rows", async () => {
  configureEnvironment()
  process.env.SENTRY_PROJECTS = "checkout-api"
  process.env.SENTRY_ENVIRONMENTS = "production"
  const now = Date.parse("2026-07-02T15:00:00.000Z")
  Date.now = () => now
  const requestUrls: URL[] = []
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    requestUrls.push(url)
    if (url.pathname.endsWith("/issues/")) {
      const secondPage = url.searchParams.has("cursor")
      return new Response(
        JSON.stringify([
          rawIssue({
            id: secondPage ? "4500000000000003" : fullIssue.id,
            title: secondPage ? "Second checkout issue" : fullIssue.title,
            count: secondPage ? 50 : 100,
            stats: {
              "14d": [
                [
                  Date.parse("2026-06-24T15:00:00.000Z") / 1_000,
                  secondPage ? 6 : 4,
                ],
                [
                  Date.parse("2026-07-01T15:00:00.000Z") / 1_000,
                  secondPage ? 5 : 10,
                ],
              ],
            },
          }),
        ]),
        {
          status: 200,
          headers: {
            Link: secondPage
              ? terminalLink(url)
              : nextLink(url, "project-issues-page-2"),
          },
        }
      )
    }
    if (url.pathname.endsWith("/projects/")) {
      return new Response(JSON.stringify([rawProject()]), {
        status: 200,
        headers: { Link: terminalLink(url) },
      })
    }
    throw new Error(`unexpected request ${url}`)
  }) as typeof fetch

  const first = await executeProjectsSync(undefined, noPacing)
  assert.equal(first.hasMore, true)
  assert.equal(first.changes.length, 0)
  assert.equal(first.nextState?.phase, "issues")
  assert.equal(requestUrls[0].searchParams.get("groupStatsPeriod"), "14d")

  process.env.SENTRY_PROJECTS = "another-project"
  process.env.SENTRY_ENVIRONMENTS = "staging"
  const second = await executeProjectsSync(first.nextState, noPacing)
  assert.equal(second.hasMore, true)
  assert.equal(second.changes.length, 0)
  assert.equal(second.nextState?.phase, "projects")
  assert.deepEqual(requestUrls[1].searchParams.getAll("project"), [
    "checkout-api",
  ])
  assert.deepEqual(requestUrls[1].searchParams.getAll("environment"), [
    "production",
  ])

  const third = await executeProjectsSync(second.nextState, noPacing)
  assert.equal(third.hasMore, false)
  assert.equal(third.changes.length, 1)
  assert.equal(third.changes[0].key, "99")
  assertPropertyContains(third.changes[0].properties?.["Events (7d)"], "15")
  assertPropertyContains(
    third.changes[0].properties?.["Issue Groups (30d)"],
    "2"
  )
  assertPropertyContains(
    third.changes[0].properties?.["Environment Scope"],
    "production"
  )
  assert.equal(requestUrls.length, 3)
})

test("projects Worker validates a resumed snapshot before making requests", async () => {
  configureEnvironment()
  let fetched = false
  globalThis.fetch = (async () => {
    fetched = true
    throw new Error("fetch should not be called")
  }) as typeof fetch
  const invalidState: ProjectSyncState = {
    phase: "projects",
    start: "2026-07-03T00:00:00.000Z",
    end: "2026-07-02T00:00:00.000Z",
    scope: defaultScope,
    aggregates: {},
  }

  await assert.rejects(
    executeProjectsSync(invalidState, noPacing),
    /must start before/
  )
  assert.equal(fetched, false)
})

test("projects Worker checkpoints oversized aggregation for a scope change", async () => {
  configureEnvironment()
  const now = Date.parse("2026-07-02T15:00:00.000Z")
  Date.now = () => now
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const issues = Array.from({ length: 100 }, (_, index) =>
      rawIssue({
        id: `issue-${index}`,
        title: `Issue ${index} ${"x".repeat(1_990)}`,
        permalink: `https://acme.sentry.io/issues/${index}/${"y".repeat(
          1_850
        )}`,
        project: {
          id: `project-${index}`,
          name: `Project ${index}`,
          slug: `project-${index}`,
          platform: "node",
        },
        stats: {
          "14d": [[Date.parse("2026-07-01T15:00:00.000Z") / 1_000, 1]],
        },
      })
    )
    return new Response(JSON.stringify(issues), {
      status: 200,
      headers: { Link: nextLink(url, "oversized-page-2") },
    })
  }) as typeof fetch

  const first = await executeProjectsSync(undefined, noPacing)
  assert.equal(first.hasMore, true)
  assert.equal(first.changes.length, 0)
  assert.equal(first.nextState?.phase, "scope-required")

  let fetched = false
  globalThis.fetch = (async () => {
    fetched = true
    throw new Error("fetch should not be called")
  }) as typeof fetch
  await assert.rejects(
    executeProjectsSync(first.nextState, noPacing),
    /paused before writing rows.*Narrow SENTRY_PROJECTS/
  )
  assert.equal(fetched, false)

  process.env.SENTRY_PROJECTS = "checkout-api"
  Date.now = () => now + 86_400_000
  let resumedUrl: URL | undefined
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    resumedUrl = url
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { Link: terminalLink(url) },
    })
  }) as typeof fetch
  const resumed = await executeProjectsSync(first.nextState, noPacing)
  assert.equal(resumed.nextState?.phase, "projects")
  assert.equal(resumedUrl?.searchParams.has("cursor"), false)
  assert.deepEqual(resumedUrl?.searchParams.getAll("project"), ["checkout-api"])
})

test("projects Worker checkpoints the active-project cap before writing rows", async () => {
  configureEnvironment()
  const now = Date.parse("2026-07-02T15:00:00.000Z")
  Date.now = () => now
  const aggregates = Object.fromEntries(
    Array.from({ length: 500 }, (_, index) => {
      const projectId = `project-${index}`
      return [projectId, projectAggregate(projectId)]
    })
  )
  const state: ProjectSyncState = {
    phase: "issues",
    start: "2026-06-02T15:00:00.000Z",
    end: "2026-07-02T15:00:00.000Z",
    scope: getSentryScope(),
    aggregates,
  }
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    return new Response(
      JSON.stringify([
        rawIssue({
          id: "issue-over-cap",
          project: {
            id: "project-over-cap",
            name: "Project over cap",
            slug: "project-over-cap",
            platform: "node",
          },
          stats: {
            "14d": [[Date.parse("2026-07-01T15:00:00.000Z") / 1_000, 1]],
          },
        }),
      ]),
      { status: 200, headers: { Link: terminalLink(url) } }
    )
  }) as typeof fetch

  const result = await executeProjectsSync(state, noPacing)
  assert.equal(result.changes.length, 0)
  assert.equal(result.nextState?.phase, "scope-required")
  if (result.nextState?.phase === "scope-required") {
    assert.equal(result.nextState.reason, "project-count")
  }
})

test("projects Worker removes emitted aggregates from inventory state", async () => {
  configureEnvironment()
  const scope = getSentryScope()
  const state: ProjectSyncState = {
    phase: "projects",
    start: "2026-06-02T15:00:00.000Z",
    end: "2026-07-02T15:00:00.000Z",
    scope,
    aggregates: {
      "99": projectAggregate("99"),
      "100": projectAggregate("100"),
    },
  }
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const hasCursor = url.searchParams.has("cursor")
    return new Response(
      JSON.stringify(
        hasCursor
          ? [rawProject({ name: "Repeated Checkout", slug: "repeated" })]
          : [rawProject()]
      ),
      {
        status: 200,
        headers: {
          Link: hasCursor ? terminalLink(url) : nextLink(url, "project-page-2"),
        },
      }
    )
  }) as typeof fetch

  const first = await executeProjectsSync(state, noPacing)
  assert.deepEqual(
    first.changes.map((change) => change.key),
    ["99"]
  )
  assertPropertyContains(first.changes[0].properties?.["Events (7d)"], "1")
  assert.equal(first.nextState?.phase, "projects")
  if (first.nextState?.phase !== "projects") {
    throw new Error("expected project inventory continuation")
  }
  assert.deepEqual(Object.keys(first.nextState.aggregates), ["100"])

  const second = await executeProjectsSync(first.nextState, noPacing)
  assert.equal(second.hasMore, false)
  assert.deepEqual(
    second.changes.map((change) => change.key),
    ["100"]
  )
  assertPropertyContains(second.changes[0].properties?.Project, "Project 100")
  assertPropertyContains(second.changes[0].properties?.["Events (7d)"], "1")
})

test("projects Worker migrates an in-flight legacy inventory state", async () => {
  configureEnvironment()
  const legacyState: ProjectSyncState = {
    phase: "projects",
    start: "2026-06-02T15:00:00.000Z",
    end: "2026-07-02T15:00:00.000Z",
    scope: getSentryScope(),
    aggregates: {
      "99": projectAggregate("99"),
      "100": projectAggregate("100"),
    },
    // Project 99 was emitted on page one; legacy state tracked only the IDs
    // that had not yet matched project inventory.
    unmatchedProjectIds: ["100"],
    cursor: "project-page-2",
  }
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    assert.equal(url.searchParams.get("cursor"), "project-page-2")
    return new Response(JSON.stringify([rawProject()]), {
      status: 200,
      headers: { Link: terminalLink(url) },
    })
  }) as typeof fetch

  const result = await executeProjectsSync(legacyState, noPacing)
  assert.equal(result.hasMore, false)
  assert.deepEqual(
    result.changes.map((change) => change.key),
    ["100"]
  )
  assertPropertyContains(result.changes[0].properties?.Project, "Project 100")
  assertPropertyContains(result.changes[0].properties?.["Events (7d)"], "1")
})

test("releases Worker uses one bounded list and one aggregate health request", async () => {
  configureEnvironment()
  process.env.SENTRY_PROJECTS = "checkout-api"
  process.env.SENTRY_ENVIRONMENTS = "production"
  const now = Date.parse("2026-07-02T15:00:00.000Z")
  Date.now = () => now
  const requestUrls: URL[] = []
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    requestUrls.push(url)
    if (url.pathname.endsWith("/releases/")) {
      return new Response(JSON.stringify([rawRelease()]), { status: 200 })
    }
    if (url.pathname.endsWith("/sessions/")) {
      return new Response(
        JSON.stringify({
          start: url.searchParams.get("start"),
          end: url.searchParams.get("end"),
          groups: [
            {
              by: { project: 99, release: fullRelease.version },
              totals: {
                "sum(session)": 12_000,
                "count_unique(user)": 4_000,
                "crash_free_rate(session)": 99.95,
                "crash_free_rate(user)": 99.5,
              },
              series: {},
            },
          ],
        }),
        { status: 200 }
      )
    }
    throw new Error(`unexpected request ${url}`)
  }) as typeof fetch

  const result = await executeReleasesSync(noPacing)
  assert.equal(result.hasMore, false)
  assert.equal(result.changes.length, 1)
  assert.equal(result.changes[0].key, "501")
  assertPropertyContains(
    result.changes[0].properties?.["Health Project Scope"],
    "checkout-api"
  )
  assertPropertyContains(
    result.changes[0].properties?.["Environment Scope"],
    "production"
  )
  assert.equal(requestUrls.length, 2)
  assert.equal(requestUrls[0].searchParams.get("per_page"), "100")
  assert.equal(requestUrls[0].searchParams.has("cursor"), false)
  assert.equal(requestUrls[1].searchParams.get("includeSeries"), "0")
})

test("releases Worker surfaces sessions 404 instead of guessing its cause", async () => {
  configureEnvironment()
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname.endsWith("/releases/")) {
      return new Response(JSON.stringify([rawRelease()]), { status: 200 })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  await assert.rejects(
    executeReleasesSync(noPacing),
    /Sentry API error \(404\)/
  )
})
