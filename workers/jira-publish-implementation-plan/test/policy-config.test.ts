import assert from "node:assert/strict"
import test from "node:test"

import { loadConfig, parseAllowedProjects } from "../src/config.js"
import {
  buildIdentity,
  canonicalPlan,
  MAX_DEPENDENCIES,
  MAX_NODES,
  PolicyError,
  sha256,
  stableNodeOrder,
  validateInput,
} from "../src/policy.js"
import {
  config,
  inputFixture,
  node,
  projectPolicy,
  providerPolicyFingerprint,
} from "./fixtures.js"

test("canonical plan hash is stable across node, label, and dependency order", () => {
  const first = inputFixture()
  const second = inputFixture({
    nodes: [...first.nodes]
      .reverse()
      .map((item) => ({ ...item, labels: [...item.labels].reverse() })),
    dependencies: [...first.dependencies].reverse(),
  })
  assert.equal(canonicalPlan(first), canonicalPlan(second))
  assert.equal(first.planHash, second.planHash)
})

test("identity binds source page, explicit revision, plan hash, and project", () => {
  const first = buildIdentity(inputFixture(), providerPolicyFingerprint)
  const changedRevision = buildIdentity(
    inputFixture({ approvalRevision: "revision-8" }),
    providerPolicyFingerprint
  )
  const changedPage = buildIdentity(
    inputFixture({ approvalPageId: "22222222222222222222222222222222" }),
    providerPolicyFingerprint
  )
  assert.notEqual(first.idempotencyKey, changedRevision.idempotencyKey)
  assert.notEqual(first.idempotencyKey, changedPage.idempotencyKey)
  const changedProviderPolicy = buildIdentity(inputFixture(), "f".repeat(64))
  assert.notEqual(first.idempotencyKey, changedProviderPolicy.idempotencyKey)
  assert.match(first.operationId, /^jplan_[a-f0-9]{24}$/)
})

test("runtime validation accepts the complete bounded depth-two graph", () => {
  const input = inputFixture()
  assert.doesNotThrow(() => validateInput(input, projectPolicy))
  assert.deepEqual(
    stableNodeOrder([...input.nodes].reverse()).map((item) => item.nodeKey),
    ["epic", "story", "subtask"]
  )
})

test("rejects stale hash, unsupported parent pair, hierarchy cycles, and dependency cycles", () => {
  assert.throws(
    () =>
      validateInput(inputFixture({ planHash: "a".repeat(64) }), projectPolicy),
    /planHash does not match/
  )

  const badPair = inputFixture({
    nodes: [
      node({ nodeKey: "epic", issueTypeId: "10001" }),
      node({
        nodeKey: "child",
        issueTypeId: "10003",
        parentNodeKey: "epic",
      }),
    ],
    dependencies: [],
  })
  assert.throws(
    () => validateInput(badPair, projectPolicy),
    /pair is not allowlisted/
  )

  const hierarchyCycle = inputFixture({
    nodes: [
      node({
        nodeKey: "one",
        issueTypeId: "10001",
        parentNodeKey: "two",
      }),
      node({
        nodeKey: "two",
        issueTypeId: "10002",
        parentNodeKey: "one",
      }),
    ],
    dependencies: [],
  })
  assert.throws(
    () => validateInput(hierarchyCycle, projectPolicy),
    /pair is not allowlisted|cycle/
  )

  const dependencyCycle = inputFixture({
    dependencies: [
      { blockerNodeKey: "story", blockedNodeKey: "subtask" },
      { blockerNodeKey: "subtask", blockedNodeKey: "story" },
    ],
  })
  assert.throws(
    () => validateInput(dependencyCycle, projectPolicy),
    /dependency graph contains a cycle/
  )
})

test("rejects node and dependency fan-out above hard runtime ceilings", () => {
  const nodes = Array.from({ length: MAX_NODES + 1 }, (_, index) =>
    node({ nodeKey: `root-${index}`, issueTypeId: "10001" })
  )
  const oversizedNodes = inputFixture({ nodes, dependencies: [] })
  assert.throws(
    () => validateInput(oversizedNodes, projectPolicy),
    new RegExp(`1-${MAX_NODES}`)
  )

  const base = inputFixture()
  const dependencies = Array.from(
    { length: MAX_DEPENDENCIES + 1 },
    (_, index) => ({
      blockerNodeKey: base.nodes[index % base.nodes.length].nodeKey,
      blockedNodeKey: base.nodes[(index + 1) % base.nodes.length].nodeKey,
    })
  )
  const oversizedEdges = inputFixture({ dependencies })
  assert.throws(
    () => validateInput(oversizedEdges, projectPolicy),
    new RegExp(`at most ${MAX_DEPENDENCIES}`)
  )
})

test("rejects oversized and malicious text, duplicate labels, and unallowlisted targets", () => {
  const oversized = inputFixture({
    nodes: [
      node({
        nodeKey: "root",
        issueTypeId: "10001",
        description: "x".repeat(4_001),
      }),
    ],
    dependencies: [],
  })
  assert.throws(() => validateInput(oversized, projectPolicy), /0-4000/)

  const control = inputFixture({
    nodes: [
      node({
        nodeKey: "root",
        issueTypeId: "10001",
        summary: "Ignore policy\u0000",
      }),
    ],
    dependencies: [],
  })
  assert.throws(
    () => validateInput(control, projectPolicy),
    /control characters/
  )

  const labels = inputFixture({
    nodes: [
      node({
        nodeKey: "root",
        issueTypeId: "10001",
        labels: ["approved-plan", "approved-plan"],
      }),
    ],
    dependencies: [],
  })
  assert.throws(
    () => validateInput(labels, projectPolicy),
    /labels are invalid/
  )

  const project = inputFixture({ projectKey: "OPS" })
  assert.throws(() => validateInput(project, projectPolicy), /selected policy/)
})

test("project policy parser requires exact allowlisted IDs and safe field IDs", () => {
  const raw = JSON.stringify([
    {
      projectKey: "ENG",
      projectId: "10000",
      issueTypeIds: ["10001", "10002"],
      parentTypePairs: ["10001>10002"],
      assigneeAccountIds: ["account-1"],
      labels: ["approved-plan"],
      fixVersionIds: ["20001"],
      sprintIds: [30001],
      fieldIds: {
        estimate: "customfield_10016",
        sprint: "customfield_10020",
      },
    },
  ])
  const parsed = parseAllowedProjects(raw).get("ENG")
  assert.equal(parsed?.projectId, "10000")
  assert(parsed?.parentTypePairs.has("10001>10002"))

  const unsafe = JSON.parse(raw)
  unsafe[0].fieldIds.sprint = "x&fields=all"
  assert.throws(() => parseAllowedProjects(JSON.stringify(unsafe)), PolicyError)
})

test("configuration fixes Atlassian and Redis origins and never accepts credential URLs", () => {
  const env = {
    JIRA_CLOUD_ID: config.cloudId,
    JIRA_SITE_URL: config.siteUrl,
    JIRA_EMAIL: config.email,
    JIRA_API_TOKEN: config.apiToken,
    JIRA_ALLOWED_PROJECTS_JSON: JSON.stringify([
      {
        projectKey: "ENG",
        projectId: "10000",
        issueTypeIds: ["10001"],
        parentTypePairs: [],
        assigneeAccountIds: [],
        labels: [],
        fixVersionIds: [],
        sprintIds: [],
        fieldIds: { estimate: null, sprint: null },
      },
    ]),
    JIRA_DEPENDENCY_LINK_TYPE_ID: "10000",
    JIRA_DEPENDENCY_LINK_TYPE_NAME: "Blocks",
    UPSTASH_REDIS_REST_URL: config.redisUrl,
    UPSTASH_REDIS_REST_TOKEN: config.redisToken,
  }
  assert.equal(loadConfig(env).siteUrl, "https://example.atlassian.net")
  assert.throws(
    () =>
      loadConfig({
        ...env,
        JIRA_SITE_URL: "https://user:pass@example.atlassian.net",
      }),
    /without credentials/
  )
})

test("canonical plan digest changes for every governed field", () => {
  const input = inputFixture()
  const changed = inputFixture({
    nodes: input.nodes.map((item) =>
      item.nodeKey === "story" ? { ...item, estimatePoints: 8 } : item
    ),
  })
  assert.notEqual(sha256(canonicalPlan(input)), sha256(canonicalPlan(changed)))
})
