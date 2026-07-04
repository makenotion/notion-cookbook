import assert from "node:assert/strict"
import test from "node:test"
import {
  canonicalReceipt,
  leaseIdentity,
  operationIdentity,
  receiptProofHash,
} from "../src/canonical.js"
import { writeReceipt } from "../src/notion.js"
import { escalateCustomerIssue } from "../src/orchestrator.js"
import { ProviderError, SafetyError } from "../src/types.js"
import type { StoredReceipt } from "../src/types.js"
import { packet, setup } from "./helpers.js"

test("successful create performs one governed issue, tag, route, internal note, and receipt", async () => {
  const fixture = setup()
  const result = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(result.status, "completed")
  assert.equal(result.ok, true)
  assert.equal(result.issueCreated, true)
  assert.equal(result.issueEnriched, false)
  assert.equal(result.customerVisibleReplySent, false)
  assert.equal(result.approvalPageId, fixture.input.approvalPageId)
  assert.equal(result.approvalRevision, fixture.input.approvalRevision)
  assert.equal(result.approvalFingerprint, fixture.input.approvalFingerprint)
  assert.deepEqual(fixture.jira.calls, {
    create: 1,
    comment: 0,
    marker: 0,
    verify: 1,
  })
  assert.deepEqual(fixture.intercom.calls.tag, 1)
  assert.deepEqual(fixture.intercom.calls.route, 1)
  assert.deepEqual(fixture.intercom.calls.note, 1)
  assert.equal(fixture.notion.updates, 1)
  assert.match(fixture.notion.receipt, /"customerVisibleReplySent":false/)
  assert.doesNotMatch(
    JSON.stringify(result),
    /ignore previous instructions|unsafe\.exe|secret/
  )
  assert.equal(result.safeAttachmentCount, 1)
})

test("completed receipt replay is read-only and returns canonical authority", async () => {
  const fixture = setup()
  const first = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  const counts = {
    jira: { ...fixture.jira.calls },
    intercom: { ...fixture.intercom.calls },
    updates: fixture.notion.updates,
  }
  fixture.store.operations.clear()
  const replay = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(first.status, "completed")
  assert.equal(replay.status, "no_op")
  assert.equal(replay.replay, true)
  assert.equal(replay.changed, false)
  assert.equal(replay.issueCreated, false)
  assert.equal(replay.receiptWritten, true)
  assert.deepEqual(fixture.jira.calls, counts.jira)
  assert.deepEqual(fixture.intercom.calls, counts.intercom)
  assert.equal(fixture.notion.updates, counts.updates)
})

test("editable Notion receipt is never completion authority without exact permanent proof and mapping", async () => {
  const fixture = setup()
  const completed = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(completed.status, "completed")
  const proof = fixture.store.receiptProofs.get(completed.operationId)
  assert.ok(proof)
  const counts = {
    jira: fixture.jira.calls.create,
    tag: fixture.intercom.calls.tag,
    route: fixture.intercom.calls.route,
    note: fixture.intercom.calls.note,
  }

  fixture.store.receiptProofs.delete(completed.operationId)
  const missingProof = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(missingProof.status, "conflict")
  assert.match(missingProof.message, /permanent.*proof/i)

  fixture.store.receiptProofs.set(completed.operationId, proof)
  const forged = JSON.parse(fixture.notion.receipt) as StoredReceipt
  forged.internalNotePartId = "forged_part"
  forged.proofHash = receiptProofHash(forged)
  fixture.notion.receipt = canonicalReceipt(forged)
  const mismatch = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(mismatch.status, "conflict")
  assert.deepEqual(
    {
      jira: fixture.jira.calls.create,
      tag: fixture.intercom.calls.tag,
      route: fixture.intercom.calls.route,
      note: fixture.intercom.calls.note,
    },
    counts
  )
})

test("competing same-operation receipt race is occupied unless text equals intended proof exactly", async () => {
  const fixture = setup()
  const completed = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  const proof = fixture.store.receiptProofs.get(completed.operationId)
  assert.ok(proof)
  const intended = structuredClone(proof.receipt)
  const competing = structuredClone(intended)
  competing.internalNotePartId = "competing_note_part"
  competing.proofHash = receiptProofHash(competing)
  fixture.notion.receipt = canonicalReceipt(competing)
  const updates = fixture.notion.updates

  await assert.rejects(
    writeReceipt(fixture.notion, fixture.input, fixture.config, intended),
    (error: unknown) => {
      assert.ok(error instanceof SafetyError)
      assert.equal(error.code, "RECEIPT_OCCUPIED")
      return true
    }
  )
  assert.equal(fixture.notion.updates, updates)
})

test("receipt replay fails closed when current target policy or permanent mapping differs", async () => {
  const policyDrift = setup()
  await escalateCustomerIssue(
    policyDrift.input,
    policyDrift.config,
    policyDrift.deps
  )
  policyDrift.config.targets[0].intercomTeamId = "team_other"
  const policyResult = await escalateCustomerIssue(
    policyDrift.input,
    policyDrift.config,
    policyDrift.deps
  )
  assert.equal(policyResult.status, "conflict")

  const mappingDrift = setup()
  const completed = await escalateCustomerIssue(
    mappingDrift.input,
    mappingDrift.config,
    mappingDrift.deps
  )
  mappingDrift.store.mappings.delete(completed.mappingId)
  const mappingResult = await escalateCustomerIssue(
    mappingDrift.input,
    mappingDrift.config,
    mappingDrift.deps
  )
  assert.equal(mappingResult.status, "conflict")
})

test("concurrent source lease returns retryable conflict with zero provider writes", async () => {
  const fixture = setup()
  const key = leaseIdentity(
    fixture.config.intercomWorkspaceId,
    fixture.input.sourceKind,
    fixture.input.sourceId
  )
  await fixture.store.acquireLease(
    key,
    "other-owner",
    fixture.config.leaseTtlMs
  )
  const result = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(result.status, "conflict")
  assert.equal(result.retryable, true)
  assert.equal(fixture.jira.calls.create, 0)
  assert.equal(fixture.intercom.calls.tag, 0)
})

test("stale or revoked Notion approval returns blocked before provider calls", async () => {
  const stale = setup()
  stale.notion.revision = "approved-r8"
  const staleResult = await escalateCustomerIssue(
    stale.input,
    stale.config,
    stale.deps
  )
  assert.equal(staleResult.status, "conflict")
  assert.equal(stale.intercom.calls.source, 0)
  assert.equal(stale.jira.calls.create, 0)

  const revoked = setup()
  revoked.notion.status = "Draft"
  const revokedResult = await escalateCustomerIssue(
    revoked.input,
    revoked.config,
    revoked.deps
  )
  assert.equal(revokedResult.status, "blocked")
  assert.equal(revoked.intercom.calls.source, 0)
})

test("changed Intercom revision or state blocks with zero writes", async () => {
  const revision = setup()
  revision.intercom.source.updatedAt += 1
  const revisionResult = await escalateCustomerIssue(
    revision.input,
    revision.config,
    revision.deps
  )
  assert.equal(revisionResult.status, "conflict")
  assert.equal(revision.jira.calls.create, 0)
  assert.equal(revision.intercom.calls.tag, 0)

  const state = setup()
  state.intercom.source.state = "closed"
  const stateResult = await escalateCustomerIssue(
    state.input,
    state.config,
    state.deps
  )
  assert.equal(stateResult.status, "conflict")
  assert.equal(state.jira.calls.create, 0)
})

test("changed contact/company association blocks before Jira", async () => {
  const fixture = setup()
  fixture.intercom.contact.companyIds = ["other_company"]
  fixture.intercom.source.companyId = null
  const result = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(result.status, "conflict")
  assert.equal(fixture.jira.calls.create, 0)
})

test("unallowlisted Jira target is blocked before provider reads and writes", async () => {
  const fixture = setup(packet({ jiraProjectKey: "OPS" }))
  const result = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(result.status, "blocked")
  assert.equal(fixture.intercom.calls.source, 0)
  assert.equal(fixture.jira.calls.create, 0)
})

test("expired provider authentication is redacted and makes no mutation", async () => {
  const fixture = setup()
  fixture.intercom.failRead = new ProviderError(
    "AUTHENTICATION_EXPIRED",
    "Intercom returned HTTP 401; super-secret-token",
    401
  )
  const result = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(result.status, "blocked")
  assert.equal(fixture.jira.calls.create, 0)
  assert.equal(fixture.intercom.calls.tag, 0)
  assert.match(result.message, /401/)
  assert.doesNotMatch(result.message, /super-secret-token/)
})

test("ambiguous Jira create that applied is reconciled in the same invocation", async () => {
  const fixture = setup()
  fixture.jira.ambiguousCreate = true
  const result = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(result.status, "completed")
  assert.equal(fixture.jira.calls.create, 1)
  assert.equal(result.issueCreated, true)
})

test("ambiguous Jira create that is not observable never posts again", async () => {
  const fixture = setup()
  fixture.jira.ambiguousCreate = true
  fixture.jira.mutateOnAmbiguous = false
  const first = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(first.status, "ambiguous")
  assert.equal(first.retryable, true)
  assert.equal(fixture.jira.calls.create, 1)
  const second = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(second.status, "ambiguous")
  assert.equal(fixture.jira.calls.create, 1)
})

test("definite Jira 429 is retryable with Retry-After and exact resume may submit once more", async () => {
  const fixture = setup()
  fixture.jira.definiteStatus = 429
  const first = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(first.status, "blocked")
  assert.equal(first.retryable, true)
  assert.equal(first.retryAfterMs, 3000)
  assert.equal(fixture.jira.calls.create, 1)
  fixture.jira.definiteStatus = null
  const resumed = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(resumed.status, "completed")
  assert.equal(fixture.jira.calls.create, 2)
})

test("approved existing issue gets exactly one marker enrichment and permanent mapping", async () => {
  const fixture = setup(packet({ destinationIssueKey: "ENG-7" }))
  fixture.jira.issue = {
    id: "10007",
    key: "ENG-7",
    projectKey: "ENG",
    issueTypeId: "10001",
    labels: [],
  }
  const result = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(result.status, "completed")
  assert.equal(result.issueCreated, false)
  assert.equal(result.issueEnriched, true)
  assert.equal(fixture.jira.calls.comment, 1)
  assert.equal(fixture.jira.calls.create, 0)
  const replay = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(replay.status, "no_op")
  assert.equal(fixture.jira.calls.comment, 1)
})

test("ambiguous Jira comment is reconciled by marker without duplication", async () => {
  const fixture = setup(packet({ destinationIssueKey: "ENG-7" }))
  fixture.jira.issue = {
    id: "10007",
    key: "ENG-7",
    projectKey: "ENG",
    issueTypeId: "10001",
    labels: [],
  }
  fixture.jira.ambiguousComment = true
  const result = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(result.status, "completed")
  assert.equal(fixture.jira.calls.comment, 1)
  assert.equal(fixture.jira.calls.marker, 1)
})

test("Jira success plus Intercom 403 is partial and resumes without duplicating Jira", async () => {
  const fixture = setup()
  fixture.intercom.definite = "route"
  const first = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(first.status, "partial_failure")
  assert.equal(first.retryable, true)
  assert.equal(first.issueCreated, true)
  assert.equal(first.resumeToken, first.operationId)
  assert.match(
    first.repairInstruction ?? "",
    /permissions.*identical five inputs/i
  )
  assert.equal(fixture.jira.calls.create, 1)
  fixture.intercom.definite = null
  const resumed = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(resumed.status, "completed")
  assert.equal(resumed.issueCreated, false)
  assert.equal(resumed.issueEnriched, false)
  assert.equal(resumed.changed, true)
  assert.equal(
    resumed.steps.find((step) => step.name === "jira")?.state,
    "skipped"
  )
  assert.equal(fixture.jira.calls.create, 1)
  assert.equal(fixture.intercom.calls.tag, 1)
  assert.equal(fixture.intercom.calls.route, 2)
})

test("ambiguous Intercom tag, routing, and note reconcile their own markers", async () => {
  for (const step of ["tag", "route", "note"] as const) {
    const fixture = setup()
    fixture.intercom.ambiguous = step
    const result = await escalateCustomerIssue(
      fixture.input,
      fixture.config,
      fixture.deps
    )
    assert.equal(result.status, "completed", step)
    assert.equal(fixture.intercom.calls[step], 1, step)
    assert.equal(result.customerVisibleReplySent, false)
  }
})

test("successful Intercom tag and route responses require authoritative reread before completion", async () => {
  for (const step of ["tag", "route"] as const) {
    const fixture = setup()
    fixture.intercom.successWithoutApply = step
    const first = await escalateCustomerIssue(
      fixture.input,
      fixture.config,
      fixture.deps
    )
    assert.equal(first.status, "partial_failure", step)
    assert.equal(first.retryable, true, step)
    const operation = fixture.store.operations.get(first.operationId)
    assert.equal(
      step === "tag" ? operation?.tagState : operation?.routeState,
      "fenced",
      step
    )
    const calls = fixture.intercom.calls[step]
    const second = await escalateCustomerIssue(
      fixture.input,
      fixture.config,
      fixture.deps
    )
    assert.equal(second.status, "partial_failure", step)
    assert.equal(fixture.intercom.calls[step], calls, step)
  }
})

test("final receipt gate revalidates exact Intercom tag and route", async () => {
  for (const step of ["tag", "route"] as const) {
    const fixture = setup()
    fixture.intercom.removeTagAfterNote = step === "tag"
    fixture.intercom.removeRouteAfterNote = step === "route"
    const first = await escalateCustomerIssue(
      fixture.input,
      fixture.config,
      fixture.deps
    )
    assert.equal(first.status, "partial_failure", step)
    assert.equal(fixture.notion.receipt, "", step)
    assert.equal(fixture.store.receiptProofs.size, 0, step)
    const operation = fixture.store.operations.get(first.operationId)
    assert.equal(
      step === "tag" ? operation?.tagState : operation?.routeState,
      "fenced",
      step
    )
    const calls = fixture.intercom.calls[step]
    const resumed = await escalateCustomerIssue(
      fixture.input,
      fixture.config,
      fixture.deps
    )
    assert.equal(resumed.status, "partial_failure", step)
    assert.equal(fixture.intercom.calls[step], calls, step)
  }
})

test("2xx response-shape failures after provider writes remain reconciliation-only", async () => {
  const fixture = setup()
  fixture.jira.createResponseShapeFailure = true
  fixture.jira.mutateOnAmbiguous = false
  const first = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(first.status, "ambiguous")
  assert.equal(fixture.jira.calls.create, 1)
  const stored = fixture.store.operations.get(first.operationId)
  assert.equal(stored?.jiraState, "fenced")
  assert.equal(stored?.jiraDisposition, "outcome_unknown")
  const resumed = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(resumed.status, "ambiguous")
  assert.equal(fixture.jira.calls.create, 1)

  const intercom = setup()
  intercom.intercom.responseShapeFailure = "tag"
  intercom.intercom.successWithoutApply = "tag"
  const intercomFirst = await escalateCustomerIssue(
    intercom.input,
    intercom.config,
    intercom.deps
  )
  assert.equal(intercomFirst.status, "partial_failure")
  assert.equal(intercom.intercom.calls.tag, 1)
  const intercomResume = await escalateCustomerIssue(
    intercom.input,
    intercom.config,
    intercom.deps
  )
  assert.equal(intercomResume.status, "partial_failure")
  assert.equal(intercom.intercom.calls.tag, 1)
})

test("partial resume accepts Worker's own updated_at/tag/route changes", async () => {
  const fixture = setup()
  fixture.intercom.definite = "note"
  const first = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(first.status, "partial_failure")
  assert.equal(
    fixture.intercom.source.updatedAt > fixture.intercom.source.updatedAt - 1,
    true
  )
  assert.equal(fixture.intercom.source.teamAssigneeId, "team_engineering")
  assert.ok(
    fixture.intercom.source.tags.some((tag) => tag.id === "tag_escalated")
  )
  fixture.intercom.definite = null
  const resumed = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(resumed.status, "completed")
  assert.equal(fixture.jira.calls.create, 1)
})

test("partial resume rejects unrelated customer evidence drift", async () => {
  const fixture = setup()
  fixture.intercom.definite = "note"
  const first = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(first.status, "partial_failure")
  fixture.intercom.definite = null
  fixture.intercom.source.parts.push({
    id: "new_customer_reply",
    type: "comment",
    body: "new unrelated evidence",
    attachments: [],
  })
  fixture.intercom.source.totalParts += 1
  const resumed = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(resumed.status, "partial_failure")
  assert.match(resumed.message, /evidence changed/)
  assert.equal(fixture.intercom.calls.note, 1)
})

test("partial resume fails closed if the configured route changes", async () => {
  const fixture = setup()
  fixture.intercom.definite = "note"
  assert.equal(
    (await escalateCustomerIssue(fixture.input, fixture.config, fixture.deps))
      .status,
    "partial_failure"
  )
  fixture.intercom.definite = null
  fixture.config.targets[0] = {
    ...fixture.config.targets[0],
    intercomTeamId: "team_other",
  }
  const resumed = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(resumed.status, "conflict")
  assert.match(resumed.message, /durable operation identity/)
  assert.equal(fixture.intercom.calls.note, 1)
})

test("Notion writeback failure preserves provider completion and resumes receipt-only", async () => {
  const fixture = setup()
  fixture.notion.failUpdate = true
  const first = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(first.status, "partial_failure")
  assert.equal(first.receiptWritten, false)
  const proof = fixture.store.receiptProofs.get(first.operationId)
  assert.ok(proof)
  assert.equal(
    fixture.store.operations.get(first.operationId)?.receiptProofHash,
    proof.proofHash
  )
  const completedAt = first.completedAt
  const counts = {
    create: fixture.jira.calls.create,
    tag: fixture.intercom.calls.tag,
    route: fixture.intercom.calls.route,
    note: fixture.intercom.calls.note,
    source: fixture.intercom.calls.source,
  }
  // Receipt-only repair must not be blocked by customer activity that occurs
  // after every provider mutation was durably completed.
  fixture.intercom.source.parts.push({
    id: "post-completion-customer-reply",
    type: "comment",
    body: "new customer detail after routing completed",
    attachments: [],
  })
  fixture.intercom.source.totalParts += 1
  fixture.notion.failUpdate = false
  const resumed = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(resumed.status, "completed")
  assert.equal(resumed.changed, true)
  assert.equal(resumed.issueCreated, false)
  assert.equal(
    resumed.steps.find((step) => step.name === "jira")?.state,
    "skipped"
  )
  assert.equal(resumed.completedAt, completedAt)
  assert.deepEqual(
    {
      create: fixture.jira.calls.create,
      tag: fixture.intercom.calls.tag,
      route: fixture.intercom.calls.route,
      note: fixture.intercom.calls.note,
      source: fixture.intercom.calls.source,
    },
    counts
  )
})

test("Notion readback failure returns partial failure and exact receipt is adopted on retry", async () => {
  const fixture = setup()
  fixture.notion.failReadback = true
  const first = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(first.status, "partial_failure")
  fixture.notion.failReadback = false
  const second = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(second.status, "no_op")
  assert.equal(second.replay, true)
  assert.equal(fixture.jira.calls.create, 1)
})

test("verified receipt remains truthfully present when final operation CAS fails", async () => {
  const fixture = setup()
  fixture.store.failReceiptSave = true
  const result = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(result.status, "completed")
  assert.equal(result.receiptWritten, true)
  assert.notEqual(fixture.notion.receipt, "")
  assert.ok(fixture.store.receiptProofs.has(result.operationId))
  assert.equal(
    fixture.store.operations.get(result.operationId)?.receiptWritten,
    false
  )
  assert.equal(
    result.records.find((record) => record.kind === "receipt")?.action,
    "receipt_written"
  )
  assert.equal(
    result.steps.find((step) => step.name === "receipt")?.state,
    "completed"
  )
  assert.match(result.warnings.join(" "), /progress flag/i)

  const replay = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(replay.status, "no_op")
  assert.equal(replay.receiptWritten, true)
  assert.equal(replay.changed, false)
  assert.equal(
    replay.records.find((record) => record.kind === "receipt")?.action,
    "unchanged"
  )
})

test("new approval cannot remap a source already mapped to another issue", async () => {
  const first = setup(packet({ destinationIssueKey: "ENG-7" }))
  first.jira.issue = {
    id: "10007",
    key: "ENG-7",
    projectKey: "ENG",
    issueTypeId: "10001",
    labels: [],
  }
  assert.equal(
    (await escalateCustomerIssue(first.input, first.config, first.deps)).status,
    "completed"
  )

  const nextPacket = packet({
    destinationIssueKey: "ENG-8",
    impact: "New impact requiring fresh approval.",
  })
  const next = setup(nextPacket)
  next.store = first.store
  next.deps.store = first.store
  next.jira.issue = {
    id: "10008",
    key: "ENG-8",
    projectKey: "ENG",
    issueTypeId: "10001",
    labels: [],
  }
  const result = await escalateCustomerIssue(next.input, next.config, next.deps)
  assert.equal(result.status, "conflict")
  assert.equal(next.jira.calls.comment, 0)
})

test("fresh approval can CAS-transfer a claiming mapping after definite rejection and negative marker reconciliation", async () => {
  const first = setup()
  first.jira.definiteStatus = 400
  const rejected = await escalateCustomerIssue(
    first.input,
    first.config,
    first.deps
  )
  assert.equal(rejected.status, "blocked")
  assert.equal(
    first.store.operations.get(rejected.operationId)?.jiraDisposition,
    "definitely_rejected"
  )

  const next = setup(
    packet({ summary: "Freshly approved escalation after rejected request" })
  )
  next.store = first.store
  next.deps.store = first.store
  const completed = await escalateCustomerIssue(
    next.input,
    next.config,
    next.deps
  )
  assert.equal(completed.status, "completed")
  assert.equal(next.jira.calls.create, 1)
  assert.equal(
    next.store.mappings.get(completed.mappingId)?.ownerOperationId,
    completed.operationId
  )
  first.jira.definiteStatus = null
  const staleResume = await escalateCustomerIssue(
    first.input,
    first.config,
    first.deps
  )
  assert.equal(staleResume.status, "conflict")
  assert.match(staleResume.message, /newer approval generation/i)
  assert.equal(first.jira.calls.create, 1)
})

test("fresh approval can transfer a durable not-sent claim only after negative Jira reconciliation", async () => {
  const first = setup()
  first.jira.failVerify = new ProviderError(
    "HTTP_403",
    "Jira returned HTTP 403.",
    403
  )
  const notSent = await escalateCustomerIssue(
    first.input,
    first.config,
    first.deps
  )
  assert.equal(notSent.status, "blocked")
  assert.equal(
    first.store.operations.get(notSent.operationId)?.jiraDisposition,
    "not_sent"
  )

  const next = setup(
    packet({ impact: "Fresh approval after create permission repair." })
  )
  next.store = first.store
  next.deps.store = first.store
  const completed = await escalateCustomerIssue(
    next.input,
    next.config,
    next.deps
  )
  assert.equal(completed.status, "completed")
})

test("claim generation prevents older approval reclaim after newer owner crashes not-sent", async () => {
  const first = setup()
  first.jira.definiteStatus = 400
  const rejected = await escalateCustomerIssue(
    first.input,
    first.config,
    first.deps
  )
  assert.equal(rejected.status, "blocked")
  assert.equal(
    first.store.operations.get(rejected.operationId)?.mappingGeneration,
    1
  )

  const newer = setup(
    packet({ summary: "Newer approval owns the monotonic claim" })
  )
  newer.store = first.store
  newer.deps.store = first.store
  newer.jira.failVerify = new ProviderError(
    "HTTP_403",
    "Jira returned HTTP 403.",
    403
  )
  const crashed = await escalateCustomerIssue(
    newer.input,
    newer.config,
    newer.deps
  )
  assert.equal(crashed.status, "blocked")
  const mapping = newer.store.mappings.get(crashed.mappingId)
  assert.equal(mapping?.ownerOperationId, crashed.operationId)
  assert.equal(mapping?.generation, 2)
  assert.equal(
    newer.store.operations.get(crashed.operationId)?.mappingGeneration,
    2
  )

  first.jira.definiteStatus = null
  const olderResume = await escalateCustomerIssue(
    first.input,
    first.config,
    first.deps
  )
  assert.equal(olderResume.status, "conflict")
  assert.match(olderResume.message, /newer approval generation/i)
  assert.equal(
    first.store.mappings.get(crashed.mappingId)?.ownerOperationId,
    crashed.operationId
  )
  assert.equal(first.store.mappings.get(crashed.mappingId)?.generation, 2)
  assert.equal(first.jira.calls.create, 1)
})

test("fresh approval never transfers a claim with unknown Jira outcome", async () => {
  const first = setup()
  first.jira.ambiguousCreate = true
  first.jira.mutateOnAmbiguous = false
  const ambiguous = await escalateCustomerIssue(
    first.input,
    first.config,
    first.deps
  )
  assert.equal(ambiguous.status, "ambiguous")

  const next = setup(
    packet({ environment: "Fresh approval cannot supersede ambiguity." })
  )
  next.store = first.store
  next.deps.store = first.store
  const blocked = await escalateCustomerIssue(
    next.input,
    next.config,
    next.deps
  )
  assert.equal(blocked.status, "conflict")
  assert.match(blocked.message, /unknown outcomes can never transfer/i)
  assert.equal(next.jira.calls.create, 0)
})

test("ticket source uses the same bounded contract", async () => {
  const fixture = setup(
    packet({
      sourceKind: "ticket",
      sourceId: "ticket_123",
      expectedSourceState: "in_progress",
    })
  )
  const result = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(result.status, "completed")
  assert.equal(result.sourceKind, "ticket")
  assert.equal(result.customerVisibleReplySent, false)
})

test("fenced operation created before a zero-write crash remains reconciliation-only", async () => {
  const fixture = setup()
  fixture.jira.ambiguousCreate = true
  fixture.jira.mutateOnAmbiguous = false
  const first = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(first.status, "ambiguous")
  const operationId = operationIdentity(fixture.input).operationId
  const stored = fixture.store.operations.get(operationId)
  assert.equal(stored?.jiraState, "fenced")
  fixture.jira.ambiguousCreate = false
  const resumed = await escalateCustomerIssue(
    fixture.input,
    fixture.config,
    fixture.deps
  )
  assert.equal(resumed.status, "ambiguous")
  assert.equal(fixture.jira.calls.create, 1)
})
