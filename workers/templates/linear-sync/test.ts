// Offline tests for the Linear sync worker.
// Run from this directory with `npm test`.

import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { RateLimitError } from "@notionhq/workers"

import {
  MAX_PAGE_SECTION_CHARACTERS,
  MAX_RENDERED_CONTRIBUTING_PROJECTS,
  cycleDisplay,
  dateOnly,
  dateTime,
  formatLinearLabel,
  healthLabel,
  latestTimestamp,
  longFormContent,
  personDisplay,
  priorityLabel,
  projectStatusLabel,
  resourcePageContent,
  workflowCategoryLabel,
} from "./src/helpers.js"
import worker from "./src/index.js"
import { initiativeToChange } from "./src/initiatives.js"
import { issueToChange, issueToSyncChange } from "./src/issues.js"
import {
  MAX_NESTED_INITIATIVE_PROJECT_REQUESTS_PER_PAGE,
  fetchInitiativesPage,
  fetchIssuesPage,
  fetchProjectsPage,
  parseRetryAfterSeconds,
  rateLimitRetryAfterSeconds,
} from "./src/linear.js"
import type {
  LinearInitiative,
  LinearInitiativeProject,
  LinearIssue,
  LinearProject,
} from "./src/linear.js"
import { projectToChange } from "./src/projects.js"
import {
  CONSISTENCY_BUFFER_MS,
  INITIAL_ISSUE_WATERMARK,
  WATERMARK_OVERLAP_MS,
  issueIncrementalWindow,
  nextCursorState,
  nextIssueWatermark,
} from "./src/sync-state.js"

const originalFetch = globalThis.fetch
const originalApiKey = process.env.LINEAR_API_KEY
const originalDateNow = Date.now

afterEach(() => {
  globalThis.fetch = originalFetch
  Date.now = originalDateNow
  if (originalApiKey === undefined) {
    delete process.env.LINEAR_API_KEY
  } else {
    process.env.LINEAR_API_KEY = originalApiKey
  }
})

function propertyText(value: unknown): string {
  return JSON.stringify(value)
}

function assertPropertyContains(value: unknown, expected: string): void {
  assert.match(
    propertyText(value),
    new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  )
}

const fullProject: LinearProject = {
  id: "f0d3f667-397d-4f29-a3bd-c34fcab57ffc",
  name: "Launch Enterprise",
  slugId: "launch-enterprise-42",
  url: "https://linear.app/acme/project/launch-enterprise-42",
  status: { name: "Custom delivery name", type: "started" },
  health: "atRisk",
  lastUpdate: {
    body: "Enterprise launch remains on track after the security review.",
    createdAt: "2026-07-01T15:16:17.654Z",
    updatedAt: "2026-07-01T16:17:18.654Z",
    url: "https://linear.app/acme/project/launch-enterprise-42/updates/last",
    user: { name: "Ada Lovelace", displayName: "Ada" },
  },
  lead: { name: "Ada Lovelace", displayName: "Ada" },
  priority: 2,
  priorityLabel: null,
  progress: 1.25,
  startDate: "2026-02-03",
  targetDate: "2026-09-30",
  startedAt: "2026-02-03T14:15:16.789Z",
  completedAt: "2026-09-29T23:59:58.123Z",
  canceledAt: null,
  createdAt: "2025-12-01T08:09:10.456Z",
  updatedAt: "2026-06-30T17:18:19.987Z",
  description: "Fallback project description",
  content: "# Launch Enterprise\n\nFull project brief.",
  archivedAt: "2026-10-01T00:00:00Z",
  trashed: false,
}

const minimalProject: LinearProject = {
  id: "b3be6524-e989-410b-b0a4-98ed6b42dc40",
  name: "Unscheduled project",
  slugId: "",
  url: "https://linear.app/acme/project/unscheduled",
  status: null,
  health: null,
  lastUpdate: null,
  lead: null,
  priority: null,
  priorityLabel: null,
  progress: null,
  startDate: null,
  targetDate: null,
  startedAt: null,
  completedAt: null,
  canceledAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T03:04:05Z",
  description: null,
  content: null,
  archivedAt: null,
  trashed: null,
}

const fullIssue: LinearIssue = {
  id: "2ec63b7f-8b80-4d4b-b19a-34ca621ba901",
  identifier: "ENG-321",
  title: "Make import resumable",
  url: "https://linear.app/acme/issue/ENG-321/make-import-resumable",
  description: "## Acceptance criteria\n\n- Resume from the saved cursor.",
  state: { name: "In Progress", type: "started" },
  priority: 1,
  priorityLabel: "",
  assignee: { name: "Grace Hopper", displayName: "Grace" },
  team: { name: "Engineering", key: "ENG" },
  project: { name: "Launch Enterprise" },
  cycle: { name: "Cycle 27", number: 27 },
  labels: {
    nodes: [{ name: "backend" }, { name: "api" }, { name: "backend" }],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  estimate: 0,
  dueDate: "2026-07-15",
  createdAt: "2026-06-01T01:02:03.456Z",
  updatedAt: "2026-06-30T20:21:22.987Z",
  startedAt: "2026-06-03T04:05:06.789Z",
  completedAt: "2026-06-29T22:23:24.123Z",
  canceledAt: null,
  archivedAt: null,
  trashed: false,
}

const minimalIssue: LinearIssue = {
  id: "7ae26556-424d-488a-a8a5-5b38e9a28088",
  identifier: "ENG-1",
  title: "Triage me",
  url: "https://linear.app/acme/issue/ENG-1/triage-me",
  description: null,
  state: null,
  priority: 0,
  priorityLabel: "",
  assignee: null,
  team: null,
  project: null,
  cycle: { name: "", number: 12 },
  labels: {
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  estimate: null,
  dueDate: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  startedAt: null,
  completedAt: null,
  canceledAt: null,
  archivedAt: null,
  trashed: null,
}

const fullInitiative: LinearInitiative = {
  id: "a4614236-8020-4eb7-8f50-cf088cc5f075",
  name: "Reach enterprise readiness",
  slugId: "enterprise-readiness-2026",
  url: "https://linear.app/acme/initiative/enterprise-readiness-2026",
  status: "Active",
  health: "offTrack",
  lastUpdate: {
    body: "The remaining enterprise blockers now have committed owners.",
    createdAt: "2026-07-02T17:18:19.321Z",
    updatedAt: "2026-07-02T18:19:20.321Z",
    url: "https://linear.app/acme/initiative/enterprise-readiness-2026/updates/last",
    user: { name: "Nan Yu", displayName: "Nan" },
  },
  owner: { name: "Katherine Johnson", displayName: "Katherine" },
  projects: {
    nodes: [
      {
        id: "project-mobile",
        name: "Mobile Reliability",
        url: "https://linear.app/acme/project/mobile-reliability",
        updatedAt: "2026-06-29T10:00:00Z",
        archivedAt: null,
        trashed: false,
      },
      {
        id: "project-api",
        name: "API Foundations",
        url: "https://linear.app/acme/project/api-foundations",
        updatedAt: "2026-06-28T10:00:00Z",
        archivedAt: "2026-06-30T00:00:00Z",
        trashed: false,
      },
      {
        id: "project-api",
        name: "Duplicate API Foundations",
        url: "https://linear.app/acme/project/api-foundations",
        updatedAt: "2026-06-28T10:00:00Z",
        archivedAt: null,
        trashed: false,
      },
      {
        id: "project-trashed",
        name: "Discarded experiment",
        url: "https://linear.app/acme/project/discarded",
        updatedAt: "2026-07-03T10:00:00Z",
        archivedAt: null,
        trashed: true,
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  targetDate: "2026-12-31",
  startedAt: "2026-01-15T11:12:13.456Z",
  completedAt: "2026-12-20T14:15:16.789Z",
  createdAt: "2025-11-01T17:18:19.123Z",
  updatedAt: "2026-06-30T20:21:22.987Z",
  description: "Fallback initiative description",
  content: "# Enterprise readiness\n\nCompany-level goal.",
  archivedAt: "2027-01-01T00:00:00Z",
  trashed: false,
}

const minimalInitiative: LinearInitiative = {
  id: "33ac57a9-f846-44e8-9889-91f061409343",
  name: "Explore a new market",
  slugId: "",
  url: "https://linear.app/acme/initiative/explore-market",
  status: null,
  health: null,
  lastUpdate: null,
  owner: null,
  projects: {
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  targetDate: null,
  startedAt: null,
  completedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  description: null,
  content: null,
  archivedAt: null,
  trashed: null,
}

test("worker manifest preserves databases, sync schedules, and shared pacing", () => {
  assert.deepEqual(
    worker.manifest.databases.map((database) => ({
      key: database.key,
      title: database.config.initialTitle,
      primaryKey: database.config.primaryKeyProperty,
      icon: database.config.schema.databaseIcon,
    })),
    [
      {
        key: "projects",
        title: "Linear Projects",
        primaryKey: "Linear Project ID",
        icon: { type: "notion", icon: "target", color: "gray" },
      },
      {
        key: "issues",
        title: "Linear Issues",
        primaryKey: "Linear Issue ID",
        icon: { type: "notion", icon: "checkmark-square", color: "gray" },
      },
      {
        key: "initiatives",
        title: "Linear Initiatives",
        primaryKey: "Linear Initiative ID",
        icon: { type: "notion", icon: "trophy", color: "gray" },
      },
    ]
  )
  assert.deepEqual(
    worker.manifest.databases.map((database) => ({
      key: database.key,
      firstSixProperties: Object.keys(database.config.schema.properties).slice(
        0,
        6
      ),
    })),
    [
      {
        key: "projects",
        firstSixProperties: [
          "Name",
          "Status",
          "Health",
          "Lead",
          "Project Link",
          "Progress %",
        ],
      },
      {
        key: "issues",
        firstSixProperties: [
          "Title",
          "Issue Key",
          "Status",
          "Priority",
          "Assignee",
          "Issue Link",
        ],
      },
      {
        key: "initiatives",
        firstSixProperties: [
          "Name",
          "Status",
          "Health",
          "Owner",
          "Initiative Link",
          "Project Count",
        ],
      },
    ]
  )

  const initiativeProperties =
    worker.manifest.databases.find((database) => database.key === "initiatives")
      ?.config.schema.properties ?? {}
  assert.equal("Priority" in initiativeProperties, false)
  assert.equal("Canceled" in initiativeProperties, false)

  type SyncManifestConfig = {
    databaseKey: string
    mode: string
    schedule: { type: string; intervalMs: number }
  }
  assert.deepEqual(
    worker.manifest.capabilities.map((capability) => {
      assert.equal(capability._tag, "sync")
      const config = capability.config as SyncManifestConfig
      return {
        key: capability.key,
        databaseKey: config.databaseKey,
        mode: config.mode,
        schedule: config.schedule,
      }
    }),
    [
      {
        key: "projectsSync",
        databaseKey: "projects",
        mode: "replace",
        schedule: { type: "interval", intervalMs: 15 * 60_000 },
      },
      {
        key: "issuesSync",
        databaseKey: "issues",
        mode: "incremental",
        schedule: { type: "interval", intervalMs: 5 * 60_000 },
      },
      {
        key: "issuesReconciliationSync",
        databaseKey: "issues",
        mode: "replace",
        schedule: { type: "interval", intervalMs: 24 * 60 * 60_000 },
      },
      {
        key: "initiativesSync",
        databaseKey: "initiatives",
        mode: "replace",
        schedule: { type: "interval", intervalMs: 60 * 60_000 },
      },
    ]
  )

  assert.deepEqual(worker.manifest.pacers, [
    {
      key: "linear",
      config: { allowedRequests: 2_000, intervalMs: 60 * 60_000 },
    },
  ])
})

test("display helpers normalize Linear values without discarding unknowns", () => {
  assert.equal(formatLinearLabel("in_progress-now"), "In Progress Now")
  assert.equal(formatLinearLabel("offTrack"), "Off Track")

  assert.equal(projectStatusLabel("started"), "Started")
  assert.equal(projectStatusLabel("CANCELLED"), "Canceled")
  assert.equal(projectStatusLabel("custom_status"), "Custom Status")
  assert.equal(projectStatusLabel("  "), null)

  assert.equal(healthLabel("onTrack"), "On Track")
  assert.equal(healthLabel("at_risk"), "At Risk")
  assert.equal(healthLabel("custom_health"), "Custom Health")
  assert.equal(healthLabel(null), null)

  assert.equal(workflowCategoryLabel("started"), "Started")
  assert.equal(workflowCategoryLabel("auto_closed"), "Auto Closed")
  assert.equal(workflowCategoryLabel(null), null)

  assert.equal(priorityLabel(1, null), "Urgent")
  assert.equal(priorityLabel(2, ""), "High")
  assert.equal(priorityLabel(99, null), "99")
  assert.equal(priorityLabel(null, "no_priority"), "No Priority")
  assert.equal(priorityLabel("4"), "Low")
  assert.equal(priorityLabel("special_case"), "Special Case")
  assert.equal(priorityLabel(null), null)
})

test("content, person, cycle, and date helpers preserve useful values", () => {
  assert.equal(
    personDisplay({ displayName: "  Display Name " }),
    "Display Name"
  )
  assert.equal(
    personDisplay({ displayName: "", name: " API Name " }),
    "API Name"
  )
  assert.equal(
    personDisplay({ email: " person@example.com " }),
    "person@example.com"
  )
  assert.equal(personDisplay(null), null)

  assert.equal(cycleDisplay({ name: " Sprint 20 ", number: 20 }), "Sprint 20")
  assert.equal(cycleDisplay({ name: "", number: 20 }), "Cycle 20")
  assert.equal(cycleDisplay(null), null)

  assert.equal(
    longFormContent("# Rich document", "description"),
    "# Rich document"
  )
  assert.equal(longFormContent(" ", "  description  "), "  description  ")
  assert.equal(longFormContent(null, null), "")
  assert.equal(dateOnly("2026-06-30T23:59:59Z"), "2026-06-30")
  assert.equal(dateOnly("  "), null)
  assert.equal(dateTime("2026-06-30T23:59:59.987Z"), "2026-06-30T23:59:59.987Z")
  assert.equal(dateTime(null), null)

  const primary = "2026-06-30T12:00:00.000Z"
  assert.equal(
    latestTimestamp(primary, "2026-07-01T12:00:00.000Z"),
    "2026-07-01T12:00:00.000Z"
  )
  assert.equal(latestTimestamp(primary, "2026-06-01T12:00:00.000Z"), primary)
  assert.equal(latestTimestamp(primary, null), primary)
  assert.equal(latestTimestamp(primary, "not-a-timestamp"), primary)
  assert.equal(
    latestTimestamp("invalid-primary", "2026-07-01T12:00:00.000Z"),
    "2026-07-01T12:00:00.000Z"
  )
})

test("page content keeps Unicode update excerpts bounded without splitting characters", () => {
  const rocket = "🚀"
  const content = resourcePageContent({
    overview: "",
    overviewHeading: "Project overview",
    resourceUrl: "https://linear.app/acme/project/unicode",
    latestUpdate: {
      body: rocket.repeat(MAX_PAGE_SECTION_CHARACTERS + 1),
    },
  })
  const [heading, notice, excerpt] = content.split("\n\n")

  assert.equal(heading, "## Latest update")
  assert.equal(Array.from(excerpt ?? "").length, MAX_PAGE_SECTION_CHARACTERS)
  assert.ok(
    Array.from(excerpt ?? "").every((character) => character === rocket)
  )
  assert.match(notice ?? "", /shortened in Notion/)
})

test("truncated Markdown cannot swallow later page-content sections", () => {
  const content = resourcePageContent({
    overview: "The overview remains visible.",
    overviewHeading: "Initiative overview",
    resourceUrl: "https://linear.app/acme/initiative/safe-markdown",
    latestUpdate: {
      body: `\`\`\`ts\n${"const value = 1\n".repeat(MAX_PAGE_SECTION_CHARACTERS)}`,
      url: "https://linear.app/acme/update/safe-markdown",
    },
    contributingProjects: [],
  })

  assert.match(content, /This latest update was shortened in Notion/)
  assert.doesNotMatch(content, /```/)
  assert.match(content, /## Contributing projects \(0\)/)
  assert.match(content, /## Initiative overview/)
  assert.match(content, /The overview remains visible\./)
})

test("page content bounds long contributing-project lists with an explicit link", () => {
  const projects = Array.from(
    { length: MAX_RENDERED_CONTRIBUTING_PROJECTS + 2 },
    (_, index) => ({
      id: `project-${index}`,
      name: `Project ${String(index).padStart(3, "0")}`,
      url: `https://linear.app/acme/project/${index}`,
    })
  )
  const content = resourcePageContent({
    overview: "",
    overviewHeading: "Initiative overview",
    resourceUrl: "https://linear.app/acme/initiative/roadmap",
    contributingProjects: projects,
  })

  assert.match(content, /## Contributing projects \(102\)/)
  assert.equal(
    content.match(/^- \[Project /gm)?.length,
    MAX_RENDERED_CONTRIBUTING_PROJECTS
  )
  assert.match(content, /…and 2 more/)
  assert.match(content, /View all projects in Linear/)
})

test("retry helpers handle delta seconds, dates, and exhausted Linear budgets", () => {
  const now = Date.parse("2026-06-30T12:00:00Z")
  assert.equal(parseRetryAfterSeconds("3.2", now), 4)
  assert.equal(parseRetryAfterSeconds("Tue, 30 Jun 2026 12:00:07 GMT", now), 7)
  assert.equal(parseRetryAfterSeconds("invalid", now), undefined)
  assert.equal(parseRetryAfterSeconds(null, now), undefined)

  const headers = new Headers({
    "retry-after": "2",
    "x-ratelimit-requests-remaining": "0",
    "x-ratelimit-requests-reset": String(now + 8_001),
    "x-ratelimit-complexity-remaining": "4",
    "x-ratelimit-complexity-reset": String(now + 60_000),
  })
  assert.equal(rateLimitRetryAfterSeconds(headers, now), 9)
  assert.equal(rateLimitRetryAfterSeconds(new Headers(), now), undefined)
})

test("project transform leads with its latest update and retains the overview", () => {
  const change = projectToChange(fullProject)

  assert.equal(change.type, "upsert")
  assert.equal(
    change.key,
    fullProject.id,
    "the immutable Linear UUID is the key"
  )
  assert.equal(change.upstreamUpdatedAt, fullProject.lastUpdate?.updatedAt)
  assert.match(change.pageContentMarkdown, /^## Latest update/)
  assert.match(change.pageContentMarkdown, /Updated by Ada · 2026-07-01/)
  assert.match(
    change.pageContentMarkdown,
    /Enterprise launch remains on track after the security review\./
  )
  assert.match(change.pageContentMarkdown, /Open update in Linear/)
  assert.match(change.pageContentMarkdown, /## Project overview/)
  assert.match(change.pageContentMarkdown, /Full project brief\./)
  assert.ok(
    change.pageContentMarkdown.indexOf("## Latest update") <
      change.pageContentMarkdown.indexOf("## Project overview")
  )
  assertPropertyContains(change.properties.Name, fullProject.name)
  assertPropertyContains(change.properties.Status, "Custom delivery name")
  assertPropertyContains(change.properties["Status Category"], "Started")
  assertPropertyContains(change.properties.Health, "At Risk")
  assertPropertyContains(change.properties.Lead, "Ada")
  assertPropertyContains(change.properties["Project Link"], fullProject.url)
  assertPropertyContains(change.properties.Priority, "High")
  assertPropertyContains(change.properties["Progress %"], "100")
  assertPropertyContains(change.properties.Updated, "2026-06-30")
  assertPropertyContains(change.properties.Updated, "17:18")
  assertPropertyContains(change.properties["Last Update At"], "2026-07-01")
  assertPropertyContains(change.properties["Last Update At"], "16:17")
  assertPropertyContains(
    change.properties["Last Update Link"],
    fullProject.lastUpdate?.url ?? ""
  )
  assertPropertyContains(change.properties.Started, "14:15")
  assertPropertyContains(change.properties.Completed, "23:59")
  assertPropertyContains(change.properties["Start Date"], "2026-02-03")
  assertPropertyContains(change.properties["Target Date"], "2026-09-30")
  assertPropertyContains(change.properties.Archived, "Yes")
  assertPropertyContains(change.properties["Slug ID"], fullProject.slugId)
  assertPropertyContains(change.properties["Linear Project ID"], fullProject.id)
})

test("project transform omits absent optional values and keeps zero progress", () => {
  const minimal = projectToChange(minimalProject)
  assert.equal(minimal.key, minimalProject.id)
  assert.equal(minimal.upstreamUpdatedAt, minimalProject.updatedAt)
  assert.equal(minimal.pageContentMarkdown, "")
  assert.equal(minimal.properties.Status, undefined)
  assert.equal(minimal.properties["Status Category"], undefined)
  assert.equal(minimal.properties.Health, undefined)
  assert.equal(minimal.properties.Lead, undefined)
  assert.equal(minimal.properties.Priority, undefined)
  assert.equal(minimal.properties["Progress %"], undefined)
  assert.equal(minimal.properties["Last Update At"], undefined)
  assert.equal(minimal.properties["Last Update Link"], undefined)
  assert.equal(minimal.properties["Start Date"], undefined)
  assert.equal(minimal.properties["Target Date"], undefined)
  assert.equal(minimal.properties.Started, undefined)
  assert.equal(minimal.properties.Completed, undefined)
  assert.equal(minimal.properties.Canceled, undefined)
  assert.equal(minimal.properties["Slug ID"], undefined)
  assertPropertyContains(minimal.properties.Archived, "No")

  const zero = projectToChange({ ...minimalProject, progress: 0 })
  assertPropertyContains(zero.properties["Progress %"], "0")
  const belowZero = projectToChange({ ...minimalProject, progress: -0.4 })
  assertPropertyContains(belowZero.properties["Progress %"], "0")
  const aboveOne = projectToChange({ ...minimalProject, progress: 3 })
  assertPropertyContains(aboveOne.properties["Progress %"], "100")
})

test("issue transform emits a full record, dedupes labels, and retains estimate zero", () => {
  const change = issueToChange(fullIssue)

  assert.equal(change.type, "upsert")
  assert.equal(change.key, fullIssue.id, "the immutable Linear UUID is the key")
  assert.equal(change.upstreamUpdatedAt, fullIssue.updatedAt)
  assert.equal(change.pageContentMarkdown, fullIssue.description)
  assertPropertyContains(change.properties.Title, fullIssue.title)
  assertPropertyContains(change.properties["Issue Key"], "ENG-321")
  assertPropertyContains(change.properties.Status, "In Progress")
  assertPropertyContains(change.properties["Workflow Category"], "Started")
  assertPropertyContains(change.properties.Priority, "Urgent")
  assertPropertyContains(change.properties.Assignee, "Grace")
  assertPropertyContains(change.properties["Issue Link"], fullIssue.url)
  assertPropertyContains(change.properties.Team, "Engineering")
  assertPropertyContains(change.properties.Project, "Launch Enterprise")
  assertPropertyContains(change.properties.Cycle, "Cycle 27")
  assert.equal(
    propertyText(change.properties.Labels).match(/backend/g)?.length,
    1
  )
  assertPropertyContains(change.properties.Labels, "api")
  assertPropertyContains(change.properties.Estimate, "0")
  assertPropertyContains(change.properties.Updated, "20:21")
  assertPropertyContains(change.properties.Started, "04:05")
  assertPropertyContains(change.properties.Completed, "22:23")
  assertPropertyContains(change.properties["Due Date"], "2026-07-15")
  assertPropertyContains(change.properties["Linear Issue ID"], fullIssue.id)
})

test("issue transform handles a minimal record and cycle-number fallback", () => {
  const change = issueToChange(minimalIssue)

  assert.equal(change.key, minimalIssue.id)
  assert.equal(change.upstreamUpdatedAt, minimalIssue.updatedAt)
  assert.equal(change.pageContentMarkdown, "")
  assert.equal(change.properties.Status, undefined)
  assert.equal(change.properties["Workflow Category"], undefined)
  assertPropertyContains(change.properties.Priority, "No Priority")
  assert.equal(change.properties.Assignee, undefined)
  assert.equal(change.properties.Team, undefined)
  assert.equal(change.properties.Project, undefined)
  assertPropertyContains(change.properties.Cycle, "Cycle 12")
  assert.equal(change.properties.Labels, undefined)
  assert.equal(change.properties.Estimate, undefined)
  assert.equal(change.properties["Due Date"], undefined)
  assert.equal(change.properties.Started, undefined)
  assert.equal(change.properties.Completed, undefined)
  assert.equal(change.properties.Canceled, undefined)
  assertPropertyContains(change.properties.Archived, "No")
})

test("issue sync changes turn soft-deleted records into immutable-key deletes", () => {
  assert.deepEqual(issueToSyncChange({ ...minimalIssue, trashed: true }), {
    type: "delete",
    key: minimalIssue.id,
  })

  const upsert = issueToSyncChange({ ...minimalIssue, trashed: false })
  assert.equal(upsert.type, "upsert")
  assert.equal(upsert.key, minimalIssue.id)
  assert.equal(upsert.upstreamUpdatedAt, minimalIssue.updatedAt)
})

test("first issue window starts at the epoch and leaves a consistency buffer", () => {
  const now = Date.parse("2026-06-30T12:00:00.000Z")

  assert.deepEqual(issueIncrementalWindow(undefined, now), {
    since: INITIAL_ISSUE_WATERMARK,
    until: new Date(now - CONSISTENCY_BUFFER_MS).toISOString(),
  })
})

test("issue window remains pinned across every cursor page", () => {
  const state = {
    since: "2026-06-01T00:00:00.000Z",
    until: "2026-06-30T11:59:45.000Z",
    after: "issue-page-2",
    seenCursors: ["issue-page-2"],
  }

  assert.deepEqual(
    issueIncrementalWindow(state, Date.parse("2027-01-01T00:00:00.000Z")),
    {
      since: state.since,
      until: state.until,
    }
  )
})

test("terminal issue watermark overlaps the completed window and validates it", () => {
  const until = "2026-06-30T12:00:00.000Z"
  assert.equal(
    nextIssueWatermark(until),
    new Date(Date.parse(until) - WATERMARK_OVERLAP_MS).toISOString()
  )
  assert.equal(
    nextIssueWatermark("1970-01-01T00:00:30.000Z"),
    INITIAL_ISSUE_WATERMARK,
    "the overlap clamps at the epoch"
  )
  assert.throws(() => nextIssueWatermark("not-a-timestamp"), /invalid end time/)
})

test("cursor state rejects missing, immediate, and longer repeated cursors", () => {
  assert.throws(
    () => nextCursorState(undefined, undefined, "projects"),
    /Linear projects pagination is missing next cursor/
  )

  const first = nextCursorState(undefined, "cursor-a", "projects")
  assert.deepEqual(first, {
    after: "cursor-a",
    seenCursors: ["cursor-a"],
  })

  assert.throws(
    () => nextCursorState(first, "cursor-a", "projects"),
    /Linear projects pagination repeated cursor/
  )

  const second = nextCursorState(first, "cursor-b", "projects")
  assert.deepEqual(second, {
    after: "cursor-b",
    seenCursors: ["cursor-a", "cursor-b"],
  })
  assert.throws(
    () => nextCursorState(second, "cursor-a", "projects"),
    /Linear projects pagination repeated cursor/,
    "serialized cursor history catches A -> B -> A loops"
  )
})

test("initiative transform surfaces its update and contributing projects", () => {
  const change = initiativeToChange(fullInitiative)

  assert.equal(change.type, "upsert")
  assert.equal(
    change.key,
    fullInitiative.id,
    "the immutable Linear UUID is the key"
  )
  assert.equal(
    "upstreamUpdatedAt" in change,
    false,
    "derived project membership is always refreshed by the hourly replacement"
  )
  assert.match(change.pageContentMarkdown, /^## Latest update/)
  assert.match(change.pageContentMarkdown, /Updated by Nan · 2026-07-02/)
  assert.match(
    change.pageContentMarkdown,
    /The remaining enterprise blockers now have committed owners\./
  )
  assert.match(change.pageContentMarkdown, /## Contributing projects \(2\)/)
  assert.match(change.pageContentMarkdown, /API Foundations.*\(archived\)/)
  assert.match(change.pageContentMarkdown, /Mobile Reliability/)
  assert.doesNotMatch(change.pageContentMarkdown, /Duplicate API Foundations/)
  assert.doesNotMatch(change.pageContentMarkdown, /Discarded experiment/)
  assert.match(change.pageContentMarkdown, /## Initiative overview/)
  assert.ok(
    change.pageContentMarkdown.indexOf("## Latest update") <
      change.pageContentMarkdown.indexOf("## Contributing projects") &&
      change.pageContentMarkdown.indexOf("## Contributing projects") <
        change.pageContentMarkdown.indexOf("## Initiative overview")
  )
  assertPropertyContains(change.properties.Name, fullInitiative.name)
  assertPropertyContains(change.properties.Status, "Active")
  assertPropertyContains(change.properties.Health, "Off Track")
  assertPropertyContains(change.properties.Owner, "Katherine")
  assertPropertyContains(
    change.properties["Initiative Link"],
    fullInitiative.url
  )
  assertPropertyContains(change.properties.Updated, "20:21")
  assertPropertyContains(change.properties["Last Update At"], "2026-07-02")
  assertPropertyContains(change.properties["Last Update At"], "18:19")
  assertPropertyContains(
    change.properties["Last Update Link"],
    fullInitiative.lastUpdate?.url ?? ""
  )
  assertPropertyContains(change.properties["Project Count"], "2")
  assertPropertyContains(change.properties.Started, "11:12")
  assertPropertyContains(change.properties.Completed, "14:15")
  assertPropertyContains(change.properties["Target Date"], "2026-12-31")
  assertPropertyContains(change.properties["Slug ID"], fullInitiative.slugId)
  assertPropertyContains(
    change.properties["Linear Initiative ID"],
    fullInitiative.id
  )
  assertPropertyContains(change.properties.Archived, "Yes")
})

test("initiative transform omits absent optional values", () => {
  const change = initiativeToChange(minimalInitiative)

  assert.equal(change.key, minimalInitiative.id)
  assert.equal("upstreamUpdatedAt" in change, false)
  assert.match(change.pageContentMarkdown, /^## Contributing projects \(0\)/)
  assert.match(
    change.pageContentMarkdown,
    /No contributing projects visible to this Linear API key\./
  )
  assert.equal(change.properties.Status, undefined)
  assert.equal(change.properties.Health, undefined)
  assert.equal(change.properties.Owner, undefined)
  assertPropertyContains(change.properties["Project Count"], "0")
  assert.equal(change.properties["Last Update At"], undefined)
  assert.equal(change.properties["Last Update Link"], undefined)
  assert.equal(change.properties["Target Date"], undefined)
  assert.equal(change.properties.Started, undefined)
  assert.equal(change.properties.Completed, undefined)
  assert.equal(change.properties["Slug ID"], undefined)
  assertPropertyContains(change.properties.Archived, "No")
})

type GraphQLRequest = {
  query: string
  variables: Record<string, unknown>
}

type FetchCall = {
  url: string
  method: string | undefined
  authorization: string | null
  accept: string | null
  contentType: string | null
  redirect: RequestRedirect | undefined
  request: GraphQLRequest
}

function installQueuedGraphQLFetch(
  responses: Array<Response | (() => Response)>,
  calls: FetchCall[]
): void {
  globalThis.fetch = (async (input, init) => {
    const headers = new Headers(init?.headers)
    const request = JSON.parse(String(init?.body)) as GraphQLRequest
    calls.push({
      url: String(input),
      method: init?.method,
      authorization: headers.get("authorization"),
      accept: headers.get("accept"),
      contentType: headers.get("content-type"),
      redirect: init?.redirect,
      request,
    })

    const next = responses.shift()
    assert.ok(next, `unexpected GraphQL request: ${request.query}`)
    return typeof next === "function" ? next() : next
  }) as typeof fetch
}

const noPacing = async (): Promise<void> => {}

function projectConnection(
  nodes: LinearProject[],
  hasNextPage: boolean,
  endCursor: string | null
): Response {
  return Response.json({
    data: { projects: { nodes, pageInfo: { hasNextPage, endCursor } } },
  })
}

function initiativeConnection(
  nodes: LinearInitiative[],
  hasNextPage: boolean,
  endCursor: string | null
): Response {
  return Response.json({
    data: { initiatives: { nodes, pageInfo: { hasNextPage, endCursor } } },
  })
}

function initiativeProjectsConnection(
  nodes: LinearInitiativeProject[],
  hasNextPage: boolean,
  endCursor: string | null
): Response {
  return Response.json({
    data: {
      initiative: {
        projects: { nodes, pageInfo: { hasNextPage, endCursor } },
      },
    },
  })
}

function initiativeProject(
  id: string,
  name: string,
  overrides: Partial<LinearInitiativeProject> = {}
): LinearInitiativeProject {
  return {
    id,
    name,
    url: `https://linear.app/acme/project/${id}`,
    updatedAt: "2026-06-30T00:00:00Z",
    archivedAt: null,
    trashed: false,
    ...overrides,
  }
}

function issueConnection(
  nodes: LinearIssue[],
  hasNextPage: boolean,
  endCursor: string | null
): Response {
  return Response.json({
    data: { issues: { nodes, pageInfo: { hasNextPage, endCursor } } },
  })
}

test("GraphQL client uses the endpoint, POST body, and direct API-key authorization", async () => {
  process.env.LINEAR_API_KEY = "lin_api_test-secret"
  const calls: FetchCall[] = []
  installQueuedGraphQLFetch(
    [projectConnection([fullProject], false, null)],
    calls
  )

  const page = await fetchProjectsPage(noPacing)

  assert.equal(page.resources[0]?.id, fullProject.id)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, "https://api.linear.app/graphql")
  assert.equal(calls[0]?.method, "POST")
  assert.equal(calls[0]?.authorization, "lin_api_test-secret")
  assert.doesNotMatch(calls[0]?.authorization ?? "", /^Bearer\s/i)
  assert.equal(calls[0]?.accept, "application/json")
  assert.equal(calls[0]?.contentType, "application/json")
  assert.equal(calls[0]?.redirect, "error")
  const projectQuery = calls[0]?.request.query ?? ""
  assert.match(projectQuery, /query Projects/)
  assert.match(projectQuery, /orderBy: createdAt/)
  assert.match(
    projectQuery,
    /lastUpdate\s*{[\s\S]*?body[\s\S]*?createdAt[\s\S]*?updatedAt[\s\S]*?url[\s\S]*?user\s*{[\s\S]*?name[\s\S]*?displayName/
  )
  assert.deepEqual(calls[0]?.request.variables, {})
})

test("project and initiative connections expose durable cursor pages", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  const calls: FetchCall[] = []
  installQueuedGraphQLFetch(
    [
      projectConnection([fullProject], true, "project-page-2"),
      projectConnection([minimalProject], false, null),
      initiativeConnection([fullInitiative], true, "initiative-page-2"),
      initiativeConnection([minimalInitiative], false, null),
    ],
    calls
  )

  const firstProjects = await fetchProjectsPage(noPacing)
  const finalProjects = await fetchProjectsPage(
    noPacing,
    firstProjects.nextCursor
  )
  const firstInitiatives = await fetchInitiativesPage(noPacing)
  const finalInitiatives = await fetchInitiativesPage(
    noPacing,
    firstInitiatives.nextCursor
  )

  assert.deepEqual(firstProjects, {
    resources: [fullProject],
    hasMore: true,
    nextCursor: "project-page-2",
  })
  assert.deepEqual(finalProjects, {
    resources: [minimalProject],
    hasMore: false,
    nextCursor: undefined,
  })
  assert.equal(firstInitiatives.resources[0]?.id, fullInitiative.id)
  assert.deepEqual(
    firstInitiatives.resources[0]?.projects.nodes.map((project) => project.id),
    ["project-mobile", "project-api", "project-trashed"]
  )
  assert.equal(firstInitiatives.hasMore, true)
  assert.equal(firstInitiatives.nextCursor, "initiative-page-2")
  assert.deepEqual(finalInitiatives, {
    resources: [minimalInitiative],
    hasMore: false,
    nextCursor: undefined,
  })
  assert.deepEqual(
    calls.map((call) => call.request.variables),
    [{}, { after: "project-page-2" }, {}, { after: "initiative-page-2" }]
  )
  assert.match(calls[0]?.request.query ?? "", /orderBy: createdAt/)
  const initiativeQuery = calls[2]?.request.query ?? ""
  assert.match(initiativeQuery, /orderBy: createdAt/)
  assert.match(initiativeQuery, /initiatives\([\s\S]*?first: 20/)
  assert.match(
    initiativeQuery,
    /lastUpdate\s*{[\s\S]*?body[\s\S]*?user\s*{[\s\S]*?name[\s\S]*?displayName/
  )
  assert.match(
    initiativeQuery,
    /projects\([\s\S]*?first: 50[\s\S]*?includeArchived: true[\s\S]*?includeSubInitiatives: true/
  )
  assert.doesNotMatch(initiativeQuery, /\bpriority\b/)
  assert.doesNotMatch(initiativeQuery, /\bcanceledAt\b/)
})

test("initiative projects paginate completely, dedupe by ID, and pace every request", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  const calls: FetchCall[] = []
  let pacingCount = 0
  const alpha = initiativeProject("alpha", "Alpha")
  const beta = initiativeProject("beta", "Beta")
  const gamma = initiativeProject("gamma", "Gamma")
  const initiative: LinearInitiative = {
    ...minimalInitiative,
    projects: {
      nodes: [alpha],
      pageInfo: { hasNextPage: true, endCursor: "project-page-2" },
    },
  }

  installQueuedGraphQLFetch(
    [
      initiativeConnection([initiative], false, null),
      initiativeProjectsConnection(
        [beta, { ...alpha, name: "Duplicate Alpha" }],
        true,
        "project-page-3"
      ),
      initiativeProjectsConnection([gamma], false, null),
    ],
    calls
  )

  const page = await fetchInitiativesPage(async () => {
    pacingCount++
  })

  assert.equal(pacingCount, 3)
  assert.deepEqual(
    page.resources[0]?.projects.nodes.map((project) => project.id),
    ["alpha", "beta", "gamma"]
  )
  assert.deepEqual(
    calls.map((call) => call.request.variables),
    [
      {},
      { initiativeId: initiative.id, after: "project-page-2" },
      { initiativeId: initiative.id, after: "project-page-3" },
    ]
  )
  assert.match(calls[1]?.request.query ?? "", /query InitiativeProjects/)
  assert.match(
    calls[1]?.request.query ?? "",
    /includeArchived: true[\s\S]*includeSubInitiatives: true/
  )
})

test("initiative project pagination rejects missing and repeated cursors", async (t) => {
  process.env.LINEAR_API_KEY = "test-key"
  const project = initiativeProject("alpha", "Alpha")

  await t.test("missing cursor", async () => {
    process.env.LINEAR_API_KEY = "test-key"
    const initiative: LinearInitiative = {
      ...minimalInitiative,
      projects: {
        nodes: [project],
        pageInfo: { hasNextPage: true, endCursor: null },
      },
    }
    installQueuedGraphQLFetch(
      [initiativeConnection([initiative], false, null)],
      []
    )

    await assert.rejects(
      () => fetchInitiativesPage(noPacing),
      /projects pagination is missing endCursor/
    )
  })

  await t.test("repeated cursor", async () => {
    process.env.LINEAR_API_KEY = "test-key"
    let pacingCount = 0
    const initiative: LinearInitiative = {
      ...minimalInitiative,
      projects: {
        nodes: [project],
        pageInfo: { hasNextPage: true, endCursor: "project-page-2" },
      },
    }
    installQueuedGraphQLFetch(
      [
        initiativeConnection([initiative], false, null),
        initiativeProjectsConnection([], true, "project-page-2"),
      ],
      []
    )

    await assert.rejects(
      () =>
        fetchInitiativesPage(async () => {
          pacingCount++
        }),
      /projects pagination repeated cursor/
    )
    assert.equal(pacingCount, 2)
  })
})

test("nested initiative project safety bound rejects incomplete snapshots", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  let pacingCount = 0
  const initiative: LinearInitiative = {
    ...minimalInitiative,
    projects: {
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: "project-page-1" },
    },
  }
  const followUpPages = Array.from(
    { length: MAX_NESTED_INITIATIVE_PROJECT_REQUESTS_PER_PAGE },
    (_, index) =>
      initiativeProjectsConnection(
        [initiativeProject(`project-${index + 1}`, `Project ${index + 1}`)],
        true,
        `project-page-${index + 2}`
      )
  )
  installQueuedGraphQLFetch(
    [initiativeConnection([initiative], false, null), ...followUpPages],
    []
  )

  await assert.rejects(
    () =>
      fetchInitiativesPage(async () => {
        pacingCount++
      }),
    new RegExp(
      `exceeded ${MAX_NESTED_INITIATIVE_PROJECT_REQUESTS_PER_PAGE} follow-up requests`
    )
  )
  assert.equal(pacingCount, 1 + MAX_NESTED_INITIATIVE_PROJECT_REQUESTS_PER_PAGE)
})

test("issue requests pin the incremental updatedAt window in GraphQL variables", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  const calls: FetchCall[] = []
  installQueuedGraphQLFetch(
    [issueConnection([minimalIssue], false, null)],
    calls
  )

  const page = await fetchIssuesPage(noPacing, {
    after: "issue-page-3",
    updatedSince: "2026-06-01T00:00:00.000Z",
    updatedBefore: "2026-07-01T00:00:00.000Z",
  })

  assert.equal(page.resources[0]?.id, minimalIssue.id)
  assert.deepEqual(calls[0]?.request.variables, {
    orderBy: "updatedAt",
    after: "issue-page-3",
    filter: {
      updatedAt: {
        gte: "2026-06-01T00:00:00.000Z",
        lt: "2026-07-01T00:00:00.000Z",
      },
    },
  })
})

test("connection pagination rejects a missing next cursor", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  installQueuedGraphQLFetch([projectConnection([], true, null)], [])

  await assert.rejects(
    () => fetchProjectsPage(noPacing),
    /Linear projects pagination response is missing endCursor/
  )
})

test("connection pagination rejects a repeated cursor", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  installQueuedGraphQLFetch([projectConnection([], true, "project-page-2")], [])

  await assert.rejects(
    () => fetchProjectsPage(noPacing, "project-page-2"),
    /Linear projects pagination repeated cursor/
  )
})

test("GraphQL errors are rejected", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  installQueuedGraphQLFetch(
    [
      Response.json({
        errors: [{ message: "Projects are unavailable", type: "INTERNAL" }],
      }),
    ],
    []
  )

  await assert.rejects(
    () => fetchProjectsPage(noPacing),
    /Linear GraphQL error: Projects are unavailable/
  )
})

test("GraphQL partial data is rejected instead of silently syncing it", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  installQueuedGraphQLFetch(
    [
      Response.json({
        data: {
          projects: {
            nodes: [fullProject],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
        errors: [{ message: "One project could not be resolved" }],
      }),
    ],
    []
  )

  await assert.rejects(
    () => fetchProjectsPage(noPacing),
    /Linear GraphQL error: One project could not be resolved/
  )
})

test("HTTP 429 preserves Retry-After in Workers RateLimitError", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  installQueuedGraphQLFetch(
    [new Response("", { status: 429, headers: { "Retry-After": "7" } })],
    []
  )

  await assert.rejects(
    () => fetchProjectsPage(noPacing),
    (error: unknown) => {
      assert.ok(error instanceof RateLimitError)
      assert.equal(error.retryAfter, 7)
      return true
    }
  )
})

test("HTTP 400 GraphQL RATELIMITED uses Linear reset headers", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  const now = Date.parse("2026-06-30T12:00:00Z")
  Date.now = () => now
  installQueuedGraphQLFetch(
    [
      Response.json(
        {
          errors: [
            {
              message: "Request budget exhausted",
              extensions: { code: "RATE_LIMITED" },
            },
          ],
        },
        {
          status: 400,
          headers: {
            "x-ratelimit-requests-remaining": "0",
            "x-ratelimit-requests-reset": String(now + 11_000),
          },
        }
      ),
    ],
    []
  )

  await assert.rejects(
    () => fetchProjectsPage(noPacing),
    (error: unknown) => {
      assert.ok(error instanceof RateLimitError)
      assert.equal(error.retryAfter, 11)
      return true
    }
  )
})

test("nested issue labels are fully paginated, deduped, and paced per request", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  const calls: FetchCall[] = []
  let pacingCount = 0
  const issueWithManyLabels: LinearIssue = {
    ...minimalIssue,
    labels: {
      nodes: [{ name: "bug" }, { name: "api" }, { name: "bug" }],
      pageInfo: { hasNextPage: true, endCursor: "label-page-2" },
    },
  }

  installQueuedGraphQLFetch(
    [
      issueConnection([issueWithManyLabels], false, null),
      Response.json({
        data: {
          issue: {
            labels: {
              nodes: [{ name: "api" }, { name: "backend" }],
              pageInfo: {
                hasNextPage: true,
                endCursor: "label-page-3",
              },
            },
          },
        },
      }),
      Response.json({
        data: {
          issue: {
            labels: {
              nodes: [{ name: "backend" }, { name: "customer" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    ],
    calls
  )

  const page = await fetchIssuesPage(async () => {
    pacingCount++
  })

  assert.equal(pacingCount, 3, "the issue page and both label pages are paced")
  assert.deepEqual(
    page.resources[0]?.labels.nodes.map((label) => label.name),
    ["bug", "api", "backend", "customer"]
  )
  assert.equal(calls.length, 3)
  assert.match(calls[0]?.request.query ?? "", /query Issues/)
  assert.match(
    calls[0]?.request.query ?? "",
    /labels\(first: 50, includeArchived: true\)/
  )
  assert.deepEqual(calls[0]?.request.variables, { orderBy: "createdAt" })
  assert.match(calls[1]?.request.query ?? "", /query IssueLabels/)
  assert.match(calls[1]?.request.query ?? "", /includeArchived: true/)
  assert.match(calls[2]?.request.query ?? "", /query IssueLabels/)
  assert.deepEqual(calls[1]?.request.variables, {
    issueId: issueWithManyLabels.id,
    after: "label-page-2",
  })
  assert.deepEqual(calls[2]?.request.variables, {
    issueId: issueWithManyLabels.id,
    after: "label-page-3",
  })
})

test("nested label safety bound rejects instead of returning truncated labels", async () => {
  process.env.LINEAR_API_KEY = "test-key"
  let pacingCount = 0
  const issue: LinearIssue = {
    ...minimalIssue,
    labels: {
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: "label-page-1" },
    },
  }
  const followUpPages = Array.from({ length: 20 }, (_, index) =>
    Response.json({
      data: {
        issue: {
          labels: {
            nodes: [{ name: `label-${index + 1}` }],
            pageInfo: {
              hasNextPage: true,
              endCursor: `label-page-${index + 2}`,
            },
          },
        },
      },
    })
  )
  installQueuedGraphQLFetch(
    [issueConnection([issue], false, null), ...followUpPages],
    []
  )

  await assert.rejects(
    () =>
      fetchIssuesPage(async () => {
        pacingCount++
      }),
    /exceeded 20 follow-up requests/
  )
  assert.equal(
    pacingCount,
    21,
    "one issue request plus exactly 20 label requests"
  )
})
