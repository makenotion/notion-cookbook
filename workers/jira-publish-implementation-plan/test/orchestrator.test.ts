import assert from "node:assert/strict"
import test from "node:test"

import { JiraError } from "../src/jira.js"
import { NotionPlanError } from "../src/notion.js"
import { PublishImplementationPlanOrchestrator } from "../src/orchestrator.js"
import { assertReceipt } from "../src/policy.js"
import {
  config,
  FakeJira,
  FakeNotion,
  inputFixture,
  MemoryLedger,
} from "./fixtures.js"

function harness(
  options: {
    jira?: FakeJira
    notion?: FakeNotion
    ledger?: MemoryLedger
  } = {}
) {
  const jira = options.jira ?? new FakeJira()
  const notion = options.notion ?? new FakeNotion()
  const ledger = options.ledger ?? new MemoryLedger()
  const orchestrator = new PublishImplementationPlanOrchestrator({
    config,
    jira,
    notion,
    ledger,
    clock: () => new Date("2026-07-03T12:00:00.000Z"),
    leaseToken: () => "lease-token",
  })
  return { orchestrator, jira, notion, ledger }
}

test("publishes the hierarchy, dependency, and canonical Notion receipt", async () => {
  const { orchestrator, jira, notion, ledger } = harness()
  const input = inputFixture()
  const result = await orchestrator.execute(input)

  assert.equal(result.status, "completed")
  assert.equal(result.changed, true)
  assert.equal(result.approvalPageId, input.approvalPageId)
  assert.equal(result.approvalRevision, input.approvalRevision)
  assert.equal(result.startedAt, "2026-07-03T12:00:00.000Z")
  assert.equal(result.completedAt, "2026-07-03T12:00:00.000Z")
  assert.equal(jira.createNodeCount, 3)
  assert.equal(jira.createDependencyCount, 1)
  assert.equal(notion.writeCount, 1)
  assert.equal(JSON.parse(notion.receipt).operationId, result.operationId)
  assert.equal(ledger.state?.stage, "completed")
  assertReceipt(result)
})

test("completed replay returns the same canonical graph without provider reads or writes", async () => {
  const context = harness()
  const input = inputFixture()
  const first = await context.orchestrator.execute(input)
  const preflightCount = context.jira.preflightCount
  const findCount = context.jira.findCount
  const second = await context.orchestrator.execute(input)

  assert.equal(first.status, "completed")
  assert.equal(second.status, "no_op")
  assert.equal(second.changed, false)
  assert.equal(second.replay, true)
  assert.equal(second.operationId, first.operationId)
  assert.equal(second.completedAt, first.completedAt)
  assert.equal(context.jira.createNodeCount, 3)
  assert.equal(context.jira.createDependencyCount, 1)
  assert.equal(context.jira.preflightCount, preflightCount)
  assert.equal(context.jira.findCount, findCount)
  assert.equal(context.notion.writeCount, 1)
  assertReceipt(second)
})

test("resume rejects altered durable node markers and graph topology", async () => {
  const corruptions: Array<
    (state: NonNullable<MemoryLedger["state"]>) => void
  > = [
    (state) => {
      state.nodes[0].nodeKey = "other"
    },
    (state) => {
      state.nodes[0].marker = "ntn-corrupt-marker"
    },
    (state) => {
      const dependency = state.dependencies[0]
      state.dependencies[0] = {
        ...dependency,
        blockerNodeKey: dependency.blockedNodeKey,
        blockedNodeKey: dependency.blockerNodeKey,
      }
    },
  ]

  for (const corrupt of corruptions) {
    const context = harness()
    const input = inputFixture()
    await context.orchestrator.execute(input)
    assert(context.ledger.state)
    corrupt(context.ledger.state)
    const createNodeCount = context.jira.createNodeCount
    const createDependencyCount = context.jira.createDependencyCount

    const result = await context.orchestrator.execute(input)

    assert.equal(result.status, "blocked")
    assert.match(result.steps[0].detail, /topology does not match/)
    assert.equal(context.jira.createNodeCount, createNodeCount)
    assert.equal(context.jira.createDependencyCount, createDependencyCount)
  }
})

test("concurrent invocation is bounded by the exact publication lease", async () => {
  const ledger = new MemoryLedger()
  ledger.leaseAvailable = false
  const { orchestrator, jira } = harness({ ledger })
  const result = await orchestrator.execute(inputFixture())

  assert.equal(result.status, "blocked")
  assert.equal(result.retryAfterSeconds, 12)
  assert.equal(result.retryable, true)
  assert.equal(jira.preflightCount, 1)
  assert.equal(jira.createNodeCount, 0)
})

test("invalid project input returns a bounded terminal conflict", async () => {
  const { orchestrator, jira } = harness()
  const input = inputFixture()
  input.projectKey = "ENG OR project = OPS"
  const result = await orchestrator.execute(input)
  assert.equal(result.status, "conflict")
  assert.equal(result.operationId, "jplan_invalid")
  assert.equal(result.changed, false)
  assert.equal(jira.preflightCount, 0)
})

test("a different approval revision cannot publish a second initial graph", async () => {
  const ledger = new MemoryLedger()
  ledger.owner = "jira-plan:" + "a".repeat(64)
  const { orchestrator, jira } = harness({ ledger })
  const result = await orchestrator.execute(inputFixture())

  assert.equal(result.status, "conflict")
  assert.match(result.steps[0].detail, /already owns a different initial/)
  assert.equal(jira.createNodeCount, 0)
})

test("stale Notion revision blocks before Jira metadata or writes", async () => {
  const notion = new FakeNotion()
  notion.verifyError = new NotionPlanError(
    "Notion approval revision is stale",
    {
      kind: "conflict",
    }
  )
  const { orchestrator, jira, ledger } = harness({ notion })
  const result = await orchestrator.execute(inputFixture())

  assert.equal(result.status, "conflict")
  assert.equal(result.changed, false)
  assert.equal(jira.preflightCount, 0)
  assert.equal(jira.createNodeCount, 0)
  assert.equal(ledger.owner, null)
})

test("a non-canonical existing receipt blocks before consuming the publication claim", async () => {
  const notion = new FakeNotion()
  notion.receipt = JSON.stringify({ status: "completed", foreign: true })
  const { orchestrator, jira, ledger } = harness({ notion })

  const result = await orchestrator.execute(inputFixture())

  assert.equal(result.status, "conflict")
  assert.equal(ledger.owner, null)
  assert.equal(jira.preflightCount, 0)
  assert.equal(jira.createNodeCount, 0)
})

test("changed provider metadata blocks with zero Jira writes", async () => {
  const jira = new FakeJira()
  jira.preflightError = new JiraError(
    "Current create metadata does not allow field sprint",
    { kind: "conflict" }
  )
  const { orchestrator, ledger } = harness({ jira })
  const result = await orchestrator.execute(inputFixture())

  assert.equal(result.status, "conflict")
  assert.equal(jira.preflightCount, 1)
  assert.equal(jira.createNodeCount, 0)
  assert.equal(jira.createDependencyCount, 0)
  assert.equal(ledger.owner, null)
})

test("metadata rejection consumes no claim so a corrected approved revision can publish", async () => {
  const jira = new FakeJira()
  jira.preflightError = new JiraError(
    "Current create metadata does not allow field sprint",
    { kind: "conflict" }
  )
  const context = harness({ jira })

  const rejected = await context.orchestrator.execute(inputFixture())
  assert.equal(rejected.status, "conflict")
  assert.equal(context.ledger.owner, null)
  assert.equal(jira.createNodeCount, 0)

  jira.preflightError = null
  const corrected = await context.orchestrator.execute(
    inputFixture({ approvalRevision: "revision-8" })
  )
  assert.equal(corrected.status, "completed")
  assert.notEqual(corrected.operationId, rejected.operationId)
  assert.equal(jira.createNodeCount, 3)
})

test("approval is re-read before each provider mutation", async () => {
  class RevokingNotion extends FakeNotion {
    override async verify(input: Parameters<FakeNotion["verify"]>[0]) {
      if (this.verifyCount >= 4) {
        throw new NotionPlanError("Notion approval is not currently approved", {
          kind: "conflict",
        })
      }
      return super.verify(input)
    }
  }
  const notion = new RevokingNotion()
  const { orchestrator, jira } = harness({ notion })
  const result = await orchestrator.execute(inputFixture())

  assert.equal(result.status, "partial_failure")
  assert.equal(jira.createNodeCount, 1)
  assert.equal(result.changed, true)
  assert.equal(result.retryable, false)
  assert.match(result.repair ?? "", /Restore the exact approved revision/)
})

test("ambiguous issue create reconciles its deterministic marker on replay", async () => {
  const jira = new FakeJira()
  jira.ambiguousCreateAt = 2
  const context = harness({ jira })
  const input = inputFixture()

  const first = await context.orchestrator.execute(input)
  assert.equal(first.status, "ambiguous")
  assert.equal(
    first.nodes.find((item) => item.nodeKey === "story")?.action,
    "unknown"
  )
  assert.equal(jira.createNodeCount, 2)

  jira.ambiguousCreateAt = null
  const second = await context.orchestrator.execute(input)
  assert.equal(second.status, "completed")
  assert.equal(jira.createNodeCount, 3)
  assert.equal(
    second.nodes.find((item) => item.nodeKey === "story")?.action,
    "existing"
  )
})

test("reconciled post-fence issue preserves conservative changed provenance", async () => {
  const jira = new FakeJira()
  jira.ambiguousCreateAt = 1
  const context = harness({ jira })
  const input = inputFixture()

  const ambiguous = await context.orchestrator.execute(input)
  assert.equal(ambiguous.status, "ambiguous")

  jira.ambiguousCreateAt = null
  jira.createNodeErrorAt = 2
  const laterFailure = await context.orchestrator.execute(input)
  assert.equal(laterFailure.status, "partial_failure")
  assert.equal(laterFailure.changed, true)
  assert.equal(laterFailure.nodes[0].action, "existing")
  assert.equal(context.ledger.state?.nodes[0].attempt, 1)
})

test("a non-expiring node fence never reposts while Jira marker search is lagging", async () => {
  const jira = new FakeJira()
  jira.ambiguousCreateAt = 2
  jira.ambiguousVisibilityLag = 2
  const context = harness({ jira })
  const input = inputFixture()

  const first = await context.orchestrator.execute(input)
  const second = await context.orchestrator.execute(input)
  const third = await context.orchestrator.execute(input)

  assert.equal(first.status, "ambiguous")
  assert.equal(first.changed, true)
  assert.equal(second.status, "ambiguous")
  assert.equal(third.status, "ambiguous")
  assert.equal(jira.createNodeCount, 2)
  assert.equal(
    context.ledger.state?.nodes.find((node) => node.nodeKey === "story")
      ?.requestDisposition,
    "outcome_unknown"
  )

  jira.ambiguousCreateAt = null
  const reconciled = await context.orchestrator.execute(input)
  assert.equal(reconciled.status, "completed")
  assert.equal(jira.createNodeCount, 3)
})

test("crash after Jira apply but before checkpoint leaves a fence and reconciles without repost", async () => {
  const ledger = new MemoryLedger()
  ledger.rejectNextAcceptedNodeCheckpoint = true
  const context = harness({ ledger })
  const input = inputFixture()

  const first = await context.orchestrator.execute(input)
  assert.equal(first.status, "ambiguous")
  assert.equal(first.changed, true)
  assert.equal(context.jira.createNodeCount, 1)
  assert.equal(ledger.state?.nodes[0].requestDisposition, "fenced")

  const second = await context.orchestrator.execute(input)
  assert.equal(second.status, "completed")
  assert.equal(context.jira.createNodeCount, 3)
  assert.equal(second.nodes[0].action, "existing")
})

test("unhandled stage checkpoint failures retain the latest durable graph context", async () => {
  for (const checkpoint of ["dependencies", "receipt"] as const) {
    const ledger = new MemoryLedger()
    if (checkpoint === "dependencies") {
      ledger.rejectNextDependencyStageCheckpoint = true
    } else {
      ledger.rejectNextWritingReceiptCheckpoint = true
    }
    const context = harness({ ledger })
    const input = inputFixture()

    const result = await context.orchestrator.execute(input)

    assert.equal(result.status, "partial_failure", checkpoint)
    assert.equal(result.changed, true, checkpoint)
    assert.equal(result.nodes.length, input.nodes.length, checkpoint)
    assert(
      result.nodes.every((node) => node.issueId !== null),
      `${checkpoint}: resolved Jira identities must survive`
    )
    assert.match(result.repair ?? "", /Retry the identical approved input/)
  }
})

test("reconciliation checkpoint failure returns the durable unresolved fence", async () => {
  const jira = new FakeJira()
  jira.ambiguousCreateAt = 1
  const ledger = new MemoryLedger()
  const context = harness({ jira, ledger })
  const input = inputFixture()
  await context.orchestrator.execute(input)

  jira.ambiguousCreateAt = null
  ledger.rejectNextExistingNodeCheckpoint = true
  const result = await context.orchestrator.execute(input)

  assert.equal(result.status, "ambiguous")
  assert.equal(result.changed, true)
  assert.equal(result.nodes[0].action, "unknown")
  assert.match(result.repair ?? "", /Retry the identical approved input/)
})

test("only a recorded definite rejection permits a later numbered attempt", async () => {
  const jira = new FakeJira()
  jira.createNodeErrorAt = 1
  const context = harness({ jira })
  const input = inputFixture()

  const rejected = await context.orchestrator.execute(input)
  assert.equal(rejected.status, "conflict")
  assert.equal(rejected.changed, false)
  assert.equal(context.ledger.state?.nodes[0].attempt, 1)
  assert.equal(
    context.ledger.state?.nodes[0].requestDisposition,
    "definitely_rejected"
  )

  jira.createNodeErrorAt = null
  const completed = await context.orchestrator.execute(input)
  assert.equal(completed.status, "completed")
  assert.equal(context.ledger.state?.nodes[0].attempt, 2)
})

test("ambiguous dependency link is read back and never posted twice", async () => {
  const jira = new FakeJira()
  jira.ambiguousLink = true
  const context = harness({ jira })
  const input = inputFixture()

  const first = await context.orchestrator.execute(input)
  assert.equal(first.status, "ambiguous")
  assert.equal(jira.createDependencyCount, 1)

  jira.ambiguousLink = false
  const second = await context.orchestrator.execute(input)
  assert.equal(second.status, "completed")
  assert.equal(jira.createDependencyCount, 1)
})

test("crash after Jira link apply leaves a durable fence and reconciles without repost", async () => {
  const ledger = new MemoryLedger()
  ledger.rejectNextAcceptedDependencyCheckpoint = true
  const context = harness({ ledger })
  const input = inputFixture()

  const first = await context.orchestrator.execute(input)
  assert.equal(first.status, "ambiguous")
  assert.equal(first.changed, true)
  assert.equal(context.jira.createDependencyCount, 1)
  assert.equal(ledger.state?.dependencies[0].requestDisposition, "fenced")

  const second = await context.orchestrator.execute(input)
  assert.equal(second.status, "completed")
  assert.equal(context.jira.createDependencyCount, 1)
  assert.equal(second.dependencies[0].action, "existing")
})

test("Notion writeback resumes after approval revocation with stable timestamps", async () => {
  const notion = new FakeNotion()
  notion.writeError = new NotionPlanError(
    "Notion receipt write failed (HTTP 503)",
    {
      kind: "unavailable",
      retryable: true,
    }
  )
  const context = harness({ notion })
  const input = inputFixture()
  const first = await context.orchestrator.execute(input)

  assert.equal(first.status, "partial_failure")
  assert.equal(first.changed, true)
  assert.equal(context.ledger.state?.stage, "writing_receipt")
  const createCount = context.jira.createNodeCount
  const preflightCount = context.jira.preflightCount
  notion.writeError = null
  notion.approved = false
  const second = await context.orchestrator.execute(input)

  assert.equal(second.status, "completed")
  assert.equal(second.startedAt, "2026-07-03T12:00:00.000Z")
  assert.equal(second.completedAt, "2026-07-03T12:00:00.000Z")
  assert.equal(context.jira.createNodeCount, createCount)
  assert.equal(context.jira.preflightCount, preflightCount)
  assert.equal(notion.writeCount, 2)
})

test("completed replay restores an empty canonical receipt even after approval revocation", async () => {
  const context = harness()
  const input = inputFixture()
  const first = await context.orchestrator.execute(input)
  const canonicalReceipt = context.notion.receipt
  const preflightCount = context.jira.preflightCount
  context.notion.receipt = ""
  context.notion.approved = false

  const restored = await context.orchestrator.execute(input)

  assert.equal(first.status, "completed")
  assert.equal(restored.status, "completed")
  assert.equal(restored.changed, true)
  assert.equal(context.notion.receipt, canonicalReceipt)
  assert.equal(context.notion.writeCount, 2)
  assert.equal(context.jira.preflightCount, preflightCount)
  assert.equal(context.jira.createNodeCount, 3)
})

test("receipt-only completion CAS failure returns full truthful recovery context", async () => {
  const notion = new FakeNotion()
  notion.writeError = new NotionPlanError("write failed", {
    kind: "unavailable",
    retryable: true,
  })
  const ledger = new MemoryLedger()
  const context = harness({ notion, ledger })
  const input = inputFixture()
  const first = await context.orchestrator.execute(input)
  assert.equal(first.status, "partial_failure")
  assert.equal(ledger.state?.stage, "writing_receipt")

  notion.writeError = null
  notion.approved = false
  ledger.rejectNextCompletionCheckpoint = true
  const unconfirmed = await context.orchestrator.execute(input)
  assert.equal(unconfirmed.status, "partial_failure")
  assert.equal(unconfirmed.changed, true)
  assert.equal(unconfirmed.notionReceiptWritten, true)
  assert.equal(unconfirmed.nodes.length, input.nodes.length)
  assert(unconfirmed.nodes.every((node) => node.issueId !== null))
  assert.match(unconfirmed.repair ?? "", /Retry the identical approved input/)
  assert.equal(ledger.state?.stage, "writing_receipt")

  const completed = await context.orchestrator.execute(input)
  assert.equal(completed.status, "completed")
  assert.equal(context.jira.createNodeCount, 3)
})

test("receipt-only Notion verification outage retains the adopted graph", async () => {
  const notion = new FakeNotion()
  notion.writeError = new NotionPlanError("write failed", {
    kind: "unavailable",
    retryable: true,
  })
  const context = harness({ notion })
  const input = inputFixture()
  await context.orchestrator.execute(input)
  assert.equal(context.ledger.state?.stage, "writing_receipt")

  notion.writeError = null
  notion.verifyError = new NotionPlanError("approval read unavailable", {
    kind: "unavailable",
    retryable: true,
  })
  const result = await context.orchestrator.execute(input)

  assert.equal(result.status, "partial_failure")
  assert.equal(result.changed, true)
  assert.equal(result.retryable, true)
  assert.equal(result.nodes.length, input.nodes.length)
  assert(result.nodes.every((node) => node.issueId !== null))
  assert.match(result.repair ?? "", /Retry the identical approved input/)
})

test("definite provider failures are redacted and partial work is resumable", async () => {
  const jira = new FakeJira()
  jira.createNodeErrorAt = 2
  const context = harness({ jira })
  const first = await context.orchestrator.execute(inputFixture())

  assert.equal(first.status, "partial_failure")
  assert.equal(first.changed, true)
  assert.equal(first.retryable, false)
  assert.doesNotMatch(
    JSON.stringify(first),
    /fake-api-token-for-tests|synthetic create failure/
  )
  assert.equal(first.nodes[0].action, "created")
})

test("all emitted terminal receipts satisfy the runtime receipt validator", async () => {
  const successContext = harness()
  const success = await successContext.orchestrator.execute(inputFixture())
  const replay = await successContext.orchestrator.execute(inputFixture())

  const blockedLedger = new MemoryLedger()
  blockedLedger.leaseAvailable = false
  const blocked = await harness({ ledger: blockedLedger }).orchestrator.execute(
    inputFixture()
  )

  const conflictJira = new FakeJira()
  conflictJira.preflightError = new JiraError("metadata conflict", {
    kind: "conflict",
  })
  const conflict = await harness({ jira: conflictJira }).orchestrator.execute(
    inputFixture()
  )

  const ambiguousJira = new FakeJira()
  ambiguousJira.ambiguousCreateAt = 1
  const ambiguous = await harness({ jira: ambiguousJira }).orchestrator.execute(
    inputFixture()
  )

  const partialNotion = new FakeNotion()
  partialNotion.writeError = new NotionPlanError("write failed", {
    kind: "unavailable",
    retryable: true,
  })
  const partial = await harness({ notion: partialNotion }).orchestrator.execute(
    inputFixture()
  )

  const completionLedger = new MemoryLedger()
  completionLedger.rejectNextCompletionCheckpoint = true
  const completionUnconfirmed = await harness({
    ledger: completionLedger,
  }).orchestrator.execute(inputFixture())
  assert.equal(completionUnconfirmed.status, "partial_failure")
  assert.equal(completionUnconfirmed.notionReceiptWritten, true)

  for (const receipt of [
    success,
    replay,
    blocked,
    conflict,
    ambiguous,
    partial,
    completionUnconfirmed,
  ]) {
    assert.doesNotThrow(() => assertReceipt(receipt), receipt.status)
  }
})
