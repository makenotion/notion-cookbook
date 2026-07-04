import assert from "node:assert/strict"
import test from "node:test"
import {
  canonicalPacket,
  canonicalReceipt,
  operationIdentity,
  packetFingerprint,
  parseMatchingReceipt,
  parsePacket,
  receiptProofHash,
  sourceGuardFingerprint,
} from "../src/canonical.js"
import { loadConfig, parseTargets } from "../src/config.js"
import type { StoredReceipt } from "../src/types.js"
import { inputFor, packet, setup } from "./helpers.js"

test("canonical packet and fingerprint are deterministic", () => {
  const value = packet()
  const parsed = parsePacket(JSON.parse(canonicalPacket(value)))
  assert.deepEqual(parsed, value)
  assert.match(packetFingerprint(value), /^[0-9a-f]{64}$/)
  assert.equal(packetFingerprint(parsed), packetFingerprint(value))
})

test("packet rejects extra keys, oversized text, and malicious control characters", () => {
  assert.throws(
    () => parsePacket({ ...packet(), extra: true }),
    /shape is invalid/
  )
  assert.throws(
    () => parsePacket({ ...packet(), impact: "x".repeat(1501) }),
    /bounded plain text/
  )
  assert.throws(
    () => parsePacket({ ...packet(), summary: "safe\u0000unsafe" }),
    /bounded plain text/
  )
})

test("packet bounds reproduction fan-out and Jira destinations", () => {
  assert.throws(
    () =>
      parsePacket({ ...packet(), reproductionSteps: Array(11).fill("step") }),
    /shape is invalid/
  )
  assert.throws(
    () => parsePacket({ ...packet(), jiraProjectKey: "../../OPS" }),
    /Jira target identity/
  )
  assert.throws(
    () => parsePacket({ ...packet(), destinationIssueKey: "not-a-key" }),
    /Jira target identity/
  )
})

test("operation marker is stable for exact authority and changes with revision", () => {
  const input = inputFor(packet())
  const first = operationIdentity(input)
  const second = operationIdentity({
    ...input,
    approvalRevision: "approved-r8",
  })
  assert.deepEqual(first, operationIdentity(input))
  assert.notEqual(first.operationId, second.operationId)
  assert.match(first.marker, /^notion-int-[0-9a-f]{24}$/)
})

test("source guard ignores only this operation's note, configured tag, routing, and updated_at", () => {
  const { intercom } = setup()
  const before = sourceGuardFingerprint(
    intercom.source,
    "notion-int-aaaaaaaaaaaaaaaaaaaaaaaa",
    "tag_escalated"
  )
  intercom.source.updatedAt += 10
  intercom.source.teamAssigneeId = "team_engineering"
  intercom.source.tags.push({ id: "tag_escalated", name: "escalated" })
  intercom.source.parts.push({
    id: "own-note",
    type: "note",
    body: "[notion-int-aaaaaaaaaaaaaaaaaaaaaaaa] linked",
    attachments: [],
  })
  assert.equal(
    sourceGuardFingerprint(
      intercom.source,
      "notion-int-aaaaaaaaaaaaaaaaaaaaaaaa",
      "tag_escalated"
    ),
    before
  )
  intercom.source.parts.push({
    id: "customer-reply",
    type: "comment",
    body: "new facts",
    attachments: [],
  })
  assert.notEqual(
    sourceGuardFingerprint(
      intercom.source,
      "notion-int-aaaaaaaaaaaaaaaaaaaaaaaa",
      "tag_escalated"
    ),
    before
  )
})

test("target policy is unique and bounded", () => {
  assert.deepEqual(
    parseTargets(
      '[{"jiraProjectKey":"ENG","jiraIssueTypeIds":["10001"],"intercomTeamId":"123","intercomTagId":"456"}]'
    )[0],
    {
      jiraProjectKey: "ENG",
      jiraIssueTypeIds: ["10001"],
      intercomTeamId: "123",
      intercomTagId: "456",
    }
  )
  assert.throws(
    () =>
      parseTargets(
        '[{"jiraProjectKey":"ENG","jiraIssueTypeIds":["1"],"intercomTeamId":"1","intercomTagId":"2"},{"jiraProjectKey":"ENG","jiraIssueTypeIds":["2"],"intercomTeamId":"1","intercomTagId":"2"}]'
      ),
    /only once/
  )
})

test("configuration rejects arbitrary Jira hosts and Redis paths", () => {
  const env: NodeJS.ProcessEnv = {
    INTERCOM_ACCESS_TOKEN: "secret",
    INTERCOM_WORKSPACE_ID: "workspace",
    INTERCOM_ADMIN_ID: "admin",
    JIRA_DOMAIN: "evil.example.com",
    JIRA_EMAIL: "a@example.com",
    JIRA_API_TOKEN: "secret",
    JIRA_ACTING_ACCOUNT_ID: "account",
    ESCALATION_TARGETS_JSON:
      '[{"jiraProjectKey":"ENG","jiraIssueTypeIds":["10001"],"intercomTeamId":"1","intercomTagId":"2"}]',
    UPSTASH_REDIS_REST_URL: "https://redis.example.com/path",
    UPSTASH_REDIS_REST_TOKEN: "secret",
  }
  assert.throws(() => loadConfig(env), /JIRA_DOMAIN/)
  env.JIRA_DOMAIN = "example"
  assert.throws(() => loadConfig(env), /without credentials or a path/)
})

test("stored receipt must bind exact page, revision, fingerprint, source, and canonical order", () => {
  const value = packet()
  const input = inputFor(value)
  const identity = operationIdentity(input)
  const receipt: StoredReceipt = {
    version: 1,
    operationId: identity.operationId,
    proofHash: "0".repeat(64),
    status: "escalated",
    approvalPageId: input.approvalPageId,
    approvalRevision: input.approvalRevision,
    approvalFingerprint: input.approvalFingerprint,
    mappingId: "icm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    mappingGeneration: 1,
    intercomTeamId: "team_engineering",
    intercomTagId: "tag_escalated",
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    jiraProjectKey: "ENG",
    jiraIssueTypeId: "10001",
    jiraIssueId: "10042",
    jiraIssueKey: "ENG-42",
    jiraUrl: "https://example.atlassian.net/browse/ENG-42",
    issueCreated: true,
    issueEnriched: false,
    tagged: true,
    routed: true,
    internalNotePartId: "part_note",
    customerVisibleReplySent: false,
    completedAt: "2026-07-03T12:00:00.000Z",
  }
  receipt.proofHash = receiptProofHash(receipt)
  const canonical = canonicalReceipt(receipt)
  assert.ok(parseMatchingReceipt(canonical, input, identity.operationId))
  assert.equal(
    parseMatchingReceipt(
      JSON.stringify({ ...receipt, approvalRevision: "other" }),
      input,
      identity.operationId
    ),
    null
  )
  assert.equal(
    parseMatchingReceipt(
      JSON.stringify(Object.fromEntries(Object.entries(receipt).reverse())),
      input,
      identity.operationId
    ),
    null
  )
  const impossible = { ...receipt, issueEnriched: true }
  impossible.proofHash = receiptProofHash(impossible)
  assert.equal(
    parseMatchingReceipt(
      canonicalReceipt(impossible),
      input,
      identity.operationId
    ),
    null
  )
})
