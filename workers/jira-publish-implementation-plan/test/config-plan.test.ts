import assert from "node:assert/strict"
import test from "node:test"

import { loadConfig, type Environment } from "../src/config.js"
import {
  buildPlanVersion,
  MAX_CHILDREN,
  MAX_DEPENDENCIES,
  normalizeDraftPlan,
  pageLabel,
  PlanError,
  validatePreparedPlan,
} from "../src/plan.js"
import type {
  DraftNode,
  DraftPlan,
  PreparedPlan,
  PreparedPlanData,
} from "../src/types.js"

const PAGE_ID = "11111111-2222-3333-4444-555555555555"
const COMPACT_PAGE_ID = PAGE_ID.replaceAll("-", "")

function env(overrides: Environment = {}): Environment {
  return {
    JIRA_CLOUD_ID: "00000000-0000-0000-0000-000000000000",
    JIRA_SITE_URL: "https://example.atlassian.net",
    JIRA_EMAIL: "worker@example.com",
    JIRA_API_TOKEN: "test-token",
    JIRA_PROJECT_ID: "10000",
    JIRA_PROJECT_KEY: "eng",
    JIRA_BLOCKS_LINK_TYPE_ID: "10001",
    ...overrides,
  }
}

function node(
  clientKey: string,
  overrides: Partial<DraftNode> = {}
): DraftNode {
  return {
    clientKey,
    summary: `${clientKey} summary`,
    description: `${clientKey} description`,
    acceptanceCriteria: `${clientKey} is complete`,
    issueTypeName: clientKey === "epic" ? "Epic" : "Story",
    issueTypeId: null,
    assigneeName: null,
    assigneeAccountId: null,
    labels: [],
    estimate: null,
    fixVersionName: null,
    fixVersionId: null,
    ...overrides,
  }
}

function draft(overrides: Partial<DraftPlan> = {}): DraftPlan {
  return {
    sourcePageId: PAGE_ID,
    epic: node("epic"),
    children: [node("api"), node("web")],
    dependencies: [{ blockerClientKey: "api", blockedClientKey: "web" }],
    ...overrides,
  }
}

function preparedData(): PreparedPlanData {
  return {
    source: {
      pageId: COMPACT_PAGE_ID,
      url: `https://www.notion.so/${COMPACT_PAGE_ID}`,
      lastEditedTime: "2026-07-05T12:00:00.000Z",
    },
    project: {
      id: "10000",
      key: "ENG",
      name: "Engineering",
      url: "https://example.atlassian.net/browse/ENG",
    },
    blocksLinkType: {
      id: "10001",
      name: "Blocks",
      outward: "blocks",
      inward: "is blocked by",
    },
    estimateFieldId: "customfield_10016",
    epic: {
      clientKey: "epic",
      summary: "Ship account recovery",
      description: "Make recovery reliable.",
      acceptanceCriteria: "Recovery works end to end.",
      issueType: { id: "10010", name: "Epic" },
      assignee: null,
      labels: ["notion-plan"],
      estimate: null,
      fixVersion: { id: "20000", name: "Q3" },
    },
    children: [
      {
        clientKey: "api",
        summary: "Build recovery API",
        description: "Add the endpoint.",
        acceptanceCriteria: "The endpoint passes its contract tests.",
        issueType: { id: "10011", name: "Story" },
        assignee: { id: "account-1", name: "Ada Lovelace" },
        labels: ["backend"],
        estimate: 3,
        fixVersion: null,
      },
      {
        clientKey: "web",
        summary: "Build recovery UI",
        description: "Add the flow.",
        acceptanceCriteria: "A user can complete recovery.",
        issueType: { id: "10011", name: "Story" },
        assignee: null,
        labels: ["frontend"],
        estimate: 2,
        fixVersion: null,
      },
    ],
    dependencies: [{ blockerClientKey: "api", blockedClientKey: "web" }],
  }
}

test("loads one fixed Jira project without Redis or a Notion database", () => {
  const config = loadConfig(env())

  assert.deepEqual(config, {
    cloudId: "00000000-0000-0000-0000-000000000000",
    siteUrl: "https://example.atlassian.net",
    email: "worker@example.com",
    apiToken: "test-token",
    projectId: "10000",
    projectKey: "ENG",
    blocksLinkTypeId: "10001",
    estimateFieldId: null,
  })
  assert.equal("redisUrl" in config, false)
  assert.equal("projects" in config, false)
})

test("accepts a configured estimate field and rejects unsafe fixed-project config", () => {
  assert.equal(
    loadConfig(env({ JIRA_ESTIMATE_FIELD_ID: "customfield_10016" }))
      .estimateFieldId,
    "customfield_10016"
  )

  assert.throws(
    () => loadConfig(env({ JIRA_ESTIMATE_FIELD_ID: "summary" })),
    /JIRA_ESTIMATE_FIELD_ID must be a Jira customfield ID/
  )
  assert.throws(
    () =>
      loadConfig(env({ JIRA_SITE_URL: "https://example.atlassian.net/path" })),
    /HTTPS origin/
  )
  assert.throws(
    () => loadConfig(env({ JIRA_PROJECT_ID: "ENG" })),
    /JIRA_PROJECT_ID must be numeric/
  )
  assert.throws(
    () => loadConfig(env({ JIRA_CLOUD_ID: "not-a-cloud-id" })),
    /JIRA_CLOUD_ID must be a UUID/
  )
})

test("normalizes a bounded epic, children, labels, and dependencies", () => {
  const normalized = normalizeDraftPlan(
    draft({
      epic: node("EPIC", { summary: "  Epic summary  " }),
      children: [
        node("WEB", { labels: ["ui", "frontend"] }),
        node("API", { labels: ["service", "backend"] }),
      ],
      dependencies: [{ blockerClientKey: " API ", blockedClientKey: " WEB " }],
    })
  )

  assert.equal(normalized.sourcePageId, COMPACT_PAGE_ID)
  assert.equal(normalized.epic.clientKey, "epic")
  assert.equal(normalized.epic.summary, "Epic summary")
  assert.deepEqual(
    normalized.children.map((item) => item.clientKey),
    ["web", "api"]
  )
  assert.deepEqual(normalized.children[0].labels, ["frontend", "ui"])
  assert.deepEqual(normalized.children[1].labels, ["backend", "service"])
  assert.deepEqual(normalized.dependencies, [
    { blockerClientKey: "api", blockedClientKey: "web" },
  ])
})

test("enforces child and dependency bounds and rejects dependency cycles", () => {
  assert.throws(
    () => normalizeDraftPlan(draft({ children: [] })),
    new RegExp(`children must contain 1-${MAX_CHILDREN}`)
  )
  assert.throws(
    () =>
      normalizeDraftPlan(
        draft({
          children: Array.from({ length: MAX_CHILDREN + 1 }, (_, index) =>
            node(`child-${index}`)
          ),
        })
      ),
    new RegExp(`children must contain 1-${MAX_CHILDREN}`)
  )

  const children = Array.from({ length: MAX_CHILDREN }, (_, index) =>
    node(`child-${index}`)
  )
  const tooManyDependencies = [
    ...Array.from({ length: MAX_CHILDREN - 1 }, (_, index) => ({
      blockerClientKey: `child-${index}`,
      blockedClientKey: `child-${index + 1}`,
    })),
    { blockerClientKey: "child-0", blockedClientKey: "child-2" },
    { blockerClientKey: "child-0", blockedClientKey: "child-3" },
  ]
  assert.equal(tooManyDependencies.length, MAX_DEPENDENCIES + 1)
  assert.throws(
    () =>
      normalizeDraftPlan(
        draft({
          children,
          dependencies: tooManyDependencies,
        })
      ),
    new RegExp(`dependencies must contain at most ${MAX_DEPENDENCIES}`)
  )

  assert.throws(
    () =>
      normalizeDraftPlan(
        draft({
          dependencies: [
            { blockerClientKey: "api", blockedClientKey: "web" },
            { blockerClientKey: "web", blockedClientKey: "api" },
          ],
        })
      ),
    /dependencies contain a cycle/
  )
})

test("rejects dependencies outside the children and reserved marker labels", () => {
  assert.throws(
    () =>
      normalizeDraftPlan(
        draft({
          dependencies: [{ blockerClientKey: "epic", blockedClientKey: "api" }],
        })
      ),
    /must reference two child work items/
  )
  assert.throws(
    () =>
      normalizeDraftPlan(
        draft({ epic: node("epic", { labels: ["notion-page-forged"] }) })
      ),
    /reserved notion-page- prefix/
  )
})

test("plan versions are deterministic but change with governed plan content", () => {
  const data = preparedData()
  const version = buildPlanVersion(data)
  const reordered: PreparedPlanData = {
    ...data,
    children: [...data.children].reverse(),
    dependencies: [...data.dependencies].reverse(),
  }
  assert.equal(buildPlanVersion(reordered), version)
  assert.notEqual(
    buildPlanVersion({
      ...data,
      project: { ...data.project, name: "Renamed project" },
      blocksLinkType: {
        ...data.blocksLinkType,
        name: "Renamed link",
        outward: "precedes",
        inward: "follows",
      },
      epic: {
        ...data.epic,
        issueType: { ...data.epic.issueType, name: "Initiative" },
      },
    }),
    version
  )

  const changed: PreparedPlanData = {
    ...data,
    children: data.children.map((item) =>
      item.clientKey === "api" ? { ...item, summary: "Changed summary" } : item
    ),
  }
  assert.notEqual(buildPlanVersion(changed), version)
  assert.notEqual(
    buildPlanVersion({
      ...data,
      source: { ...data.source, lastEditedTime: "2026-07-05T12:01:00.000Z" },
    }),
    version
  )
  assert.notEqual(
    buildPlanVersion({
      ...data,
      source: { ...data.source, url: "https://www.notion.so/other-page" },
    }),
    version
  )
  assert.notEqual(
    buildPlanVersion({
      ...data,
      estimateFieldId: "customfield_10017",
    }),
    version
  )
})

test("validates the exact prepared version and deterministic page marker", () => {
  const data = preparedData()
  const plan: PreparedPlan = { ...data, planVersion: buildPlanVersion(data) }

  assert.deepEqual(
    validatePreparedPlan({
      ...plan,
      children: [...plan.children].reverse(),
    }).children.map((item) => item.clientKey),
    ["api", "web"]
  )
  assert.throws(
    () =>
      validatePreparedPlan({
        ...plan,
        planVersion: `sha256:${"0".repeat(64)}`,
      }),
    /does not match the exact plan/
  )
  assert.equal(pageLabel(PAGE_ID), `notion-page-${COMPACT_PAGE_ID}`)
  assert.throws(() => pageLabel("not-a-page"), PlanError)
})
