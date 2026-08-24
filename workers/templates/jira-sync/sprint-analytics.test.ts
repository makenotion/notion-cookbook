import assert from "node:assert/strict"
import test from "node:test"
import type { JiraChangeHistory, JiraIssue, JiraSprint } from "./src/jira.js"
import { normalizeSprintIssueTimeline } from "./src/all-sprints.js"
import {
  calculateSprintAnalytics,
  renderSprintIssueRoster,
  sprintAnalyticsToChange,
} from "./src/sprint-analytics.js"
import type {
  NormalizedSprintIssueTimeline,
  SprintAnalyticsInput,
} from "./src/sprint-analytics.js"

const START = "2026-06-01T00:00:00.000Z"
const END = "2026-06-14T00:00:00.000Z"

function timeline(
  id: string,
  key: string,
  summary: string,
  options: {
    enteredAt?: string | null
    exitedAt?: string | null
    estimate: number | null
    estimateChanges?: { at: string; value: number | null }[]
    completed?: boolean
    completedAt?: string
    isSubtask?: boolean
    rollover?: { sprintId: string; sprintName: string }
  }
): NormalizedSprintIssueTimeline {
  return {
    id,
    key,
    summary,
    url: `https://acme.atlassian.net/browse/${key}`,
    isSubtask: options.isSubtask,
    memberships: [
      {
        enteredAt: options.enteredAt ?? null,
        exitedAt: options.exitedAt ?? null,
      },
    ],
    estimates: [
      { at: null, value: options.estimate },
      ...(options.estimateChanges ?? []),
    ],
    completion: options.completedAt
      ? [
          { at: null, completed: false },
          { at: options.completedAt, completed: true },
        ]
      : [{ at: null, completed: options.completed ?? false }],
    rollover: options.rollover,
  }
}

function closedSprintInput(): SprintAnalyticsInput {
  return {
    id: "sprint-1",
    name: "Sprint 1",
    state: "closed",
    boardId: "10",
    boardName: "Payments",
    goal: "Ship checkout recovery",
    startAt: START,
    endAt: END,
    completeAt: END,
    evaluatedAt: "2026-06-15T12:00:00.000Z",
    estimationBasis: "Story Points",
    priorSprintVelocities: [9, 7, 6, 8],
    issues: [
      timeline("1", "PAY-1", "Completed commitment", {
        estimate: 5,
        completedAt: "2026-06-10T12:00:00.000Z",
      }),
      timeline("2", "PAY-2", "Removed after estimate grew", {
        estimate: 3,
        estimateChanges: [{ at: "2026-06-05T12:00:00.000Z", value: 5 }],
        exitedAt: "2026-06-09T12:00:00.000Z",
      }),
      timeline("3", "PAY-3", "Added then rolled over", {
        enteredAt: "2026-06-04T12:00:00.000Z",
        estimate: 2,
        rollover: { sprintId: "sprint-2", sprintName: "Sprint 2" },
      }),
      timeline("4", "PAY-4", "Excluded subtask", {
        estimate: 13,
        completed: true,
        isSubtask: true,
      }),
    ],
  }
}

test("calculates closed-sprint scope, delivery, rollover, and velocity", () => {
  const metrics = calculateSprintAnalytics(closedSprintInput())

  assert.equal(metrics.committedIssueCount, 2)
  assert.equal(metrics.committedPoints, 8)
  assert.equal(metrics.currentIssueCount, 2)
  assert.equal(metrics.currentPoints, 7)
  assert.equal(metrics.completedIssueCount, 1)
  assert.equal(metrics.completedPoints, 5)
  assert.equal(metrics.addedIssueCount, 1)
  assert.equal(metrics.addedPoints, 2)
  assert.equal(metrics.removedIssueCount, 1)
  assert.equal(metrics.removedPoints, 5)
  assert.equal(metrics.estimateChange, 2)
  assert.equal(metrics.reconstructedScopePoints, 7)
  assert.equal(metrics.netScopeChangePoints, -1)
  assert.equal(metrics.rolledOverIssueCount, 1)
  assert.equal(metrics.rolledOverPoints, 2)
  assert.equal(metrics.completionPercent, 5 / 7)
  assert.equal(metrics.predictabilityPercent, 5 / 8)
  assert.equal(metrics.velocity, 5)
  assert.equal(metrics.rollingVelocity3, 7)
  assert.equal(metrics.rollingVelocity5, 7)
  assert.equal(metrics.deliveryForecast, "Missed")
  assert.equal(metrics.forecastCompletionPercent, 5 / 7)
  assert.equal(metrics.daysRemaining, 0)
  assert.equal(metrics.dataQuality, "Complete")
})

test("uses rolling velocity and remaining time for an active forecast", () => {
  const input: SprintAnalyticsInput = {
    id: "sprint-active",
    name: "Active Sprint",
    state: "active",
    startAt: "2026-07-01T00:00:00.000Z",
    endAt: "2026-07-11T00:00:00.000Z",
    evaluatedAt: "2026-07-06T00:00:00.000Z",
    estimationBasis: "Story Points",
    priorSprintVelocities: [22, 22, 22],
    issues: [
      timeline("10", "PAY-10", "Done", { estimate: 5, completed: true }),
      timeline("11", "PAY-11", "Still in progress", {
        estimate: 15,
      }),
    ],
  }

  const metrics = calculateSprintAnalytics(input)

  assert.equal(metrics.velocity, 5)
  assert.equal(metrics.rollingVelocity3, 22)
  assert.equal(metrics.daysRemaining, 5)
  assert.equal(metrics.deliveryForecast, "At Risk")
  assert.equal(metrics.forecastCompletionPercent, 0.8)
})

test("does not overstate an active forecast without three prior sprints", () => {
  const input: SprintAnalyticsInput = {
    id: "sprint-new-team",
    name: "New Team Sprint",
    state: "active",
    startAt: "2026-07-01T00:00:00.000Z",
    endAt: "2026-07-11T00:00:00.000Z",
    evaluatedAt: "2026-07-06T00:00:00.000Z",
    estimationBasis: "Story Points",
    priorSprintVelocities: [8, 5],
    issues: [timeline("12", "PAY-12", "In progress", { estimate: 8 })],
  }

  const metrics = calculateSprintAnalytics(input)

  assert.equal(metrics.rollingVelocity3, null)
  assert.equal(metrics.deliveryForecast, "Insufficient Data")
  assert.equal(metrics.forecastCompletionPercent, null)
})

test("uses issue counts when a board has no point estimation", () => {
  const input: SprintAnalyticsInput = {
    id: "sprint-count",
    name: "Issue-count Sprint",
    state: "closed",
    startAt: START,
    endAt: END,
    completeAt: END,
    evaluatedAt: "2026-06-15T12:00:00.000Z",
    estimationBasis: "Issue Count",
    priorSprintVelocities: [4, 6],
    issues: [
      timeline("20", "PAY-20", "Completed", {
        estimate: 1,
        completed: true,
      }),
      timeline("21", "PAY-21", "Incomplete", {
        estimate: 1,
      }),
    ],
  }

  const metrics = calculateSprintAnalytics(input)
  const change = sprintAnalyticsToChange(input)

  assert.equal(metrics.estimationBasis, "Issue Count")
  assert.equal(metrics.velocity, 1)
  assert.equal(metrics.rollingVelocity3, 11 / 3)
  assert.equal(metrics.completionPercent, 0.5)
  assert.equal("Committed Points" in change.properties, false)
  assert.match(change.pageContentMarkdown, /1 issue/)
})

test("renders an auditable, grouped issue roster", () => {
  const roster = renderSprintIssueRoster(closedSprintInput())

  assert.match(roster, /## Sprint Goal\n\nShip checkout recovery/)
  assert.match(roster, /## Committed and completed[\s\S]*PAY-1/)
  assert.match(roster, /## Removed from sprint[\s\S]*PAY-2/)
  assert.match(roster, /## Rolled over[\s\S]*PAY-3[\s\S]*Sprint 2/)
  assert.match(roster, /## Subtasks[\s\S]*PAY-4/)
})

test("transforms sprint analytics into a stable Notion upsert", () => {
  const change = sprintAnalyticsToChange(closedSprintInput())
  const properties = JSON.stringify(change.properties)

  assert.equal(change.type, "upsert")
  assert.equal(change.key, "sprint-1")
  assert.equal(change.upstreamUpdatedAt, "2026-06-15T12:00:00.000Z")
  assert.match(change.pageContentMarkdown, /PAY-1/)
  assert.match(properties, /Sprint 1/)
  assert.match(properties, /Payments/)
  assert.match(properties, /Missed/)
  assert.match(properties, /sprint-1/)
  assert.ok("Committed Points" in change.properties)
  assert.ok("Completion %" in change.properties)
  assert.ok("3-Sprint Velocity" in change.properties)
})

test("normalizes Jira changelogs into an API-independent issue timeline", () => {
  const sprint: JiraSprint = {
    id: 42,
    name: "Sprint 42",
    state: "closed",
    startDate: START,
    endDate: END,
    completeDate: END,
    goal: "Recover failed payments",
    originBoardId: 10,
  }
  const issue: JiraIssue = {
    id: "10042",
    key: "PAY-42",
    self: "https://acme.atlassian.net/rest/api/3/issue/10042",
    fields: {
      summary: "Retry failed card",
      status: { id: "3", name: "Done", statusCategory: { name: "Done" } },
      issuetype: { name: "Story", subtask: false, hierarchyLevel: 0 },
      priority: null,
      assignee: null,
      reporter: null,
      project: { key: "PAY", name: "Payments" },
      labels: [],
      components: [],
      fixVersions: [],
      resolution: null,
      description: null,
      duedate: null,
      created: "2026-05-20T00:00:00.000Z",
      updated: "2026-06-15T00:00:00.000Z",
      customfield_10020: [{ id: 42 }, { id: 43 }],
      customfield_10016: 5,
    },
  }
  const histories: JiraChangeHistory[] = [
    {
      id: "4",
      created: "2026-06-14T00:01:00.000Z",
      items: [
        {
          field: "Sprint",
          fieldId: "customfield_10020",
          from: "id=40,id=42",
          to: "id=40,id=42,id=43",
          toString: undefined,
        },
      ],
    },
    {
      id: "2",
      created: "2026-06-05T12:00:00.000Z",
      items: [
        {
          field: "Story Points",
          fieldId: "customfield_10016",
          from: null,
          fromString: "3",
          to: null,
          toString: "5",
        },
      ],
    },
    {
      id: "1",
      created: "2026-05-31T12:00:00.000Z",
      items: [
        {
          field: "Sprint",
          fieldId: "customfield_10020",
          from: "id=40",
          to: "id=40,id=42",
          toString: undefined,
        },
      ],
    },
    {
      id: "3",
      created: "2026-06-10T12:00:00.000Z",
      items: [
        {
          field: "status",
          fieldId: "status",
          from: "2",
          to: "3",
          toString: undefined,
        },
      ],
    },
  ]

  const normalized = normalizeSprintIssueTimeline(issue, histories, {
    sprint,
    sprintFieldId: "customfield_10020",
    estimateFieldId: "customfield_10016",
    estimationType: "field",
    doneStatusIds: ["3"],
    baseUrl: "https://acme.atlassian.net",
    sprintNamesById: { "43": "Sprint 43" },
  })

  assert.deepEqual(normalized.memberships, [
    { enteredAt: "2026-05-31T12:00:00.000Z", exitedAt: null },
  ])
  assert.deepEqual(normalized.estimates, [
    { at: null, value: 3 },
    { at: "2026-06-05T12:00:00.000Z", value: 5 },
  ])
  assert.deepEqual(normalized.completion, [
    { at: null, completed: false },
    { at: "2026-06-10T12:00:00.000Z", completed: true },
  ])
  assert.deepEqual(normalized.rollover, {
    sprintId: "43",
    sprintName: "Sprint 43",
  })
  assert.equal(normalized.url, "https://acme.atlassian.net/browse/PAY-42")
  assert.equal(normalized.isSubtask, false)

  const createdInSprint = normalizeSprintIssueTimeline(
    {
      ...issue,
      id: "10043",
      key: "PAY-43",
      fields: {
        ...issue.fields,
        created: "2026-06-06T12:00:00.000Z",
        status: {
          id: "99",
          name: "Cancelled",
          statusCategory: { name: "Done" },
        },
      },
    },
    [],
    {
      sprint,
      sprintFieldId: "customfield_10020",
      estimateFieldId: "customfield_10016",
      estimationType: "field",
      doneStatusIds: ["3"],
      baseUrl: "https://acme.atlassian.net",
      sprintNamesById: { "43": "Sprint 43" },
    }
  )

  assert.deepEqual(createdInSprint.memberships, [
    { enteredAt: "2026-06-06T12:00:00.000Z", exitedAt: null },
  ])
  assert.deepEqual(createdInSprint.completion, [{ at: null, completed: false }])
})
