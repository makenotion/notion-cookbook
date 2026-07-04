import assert from "node:assert/strict"
import { test } from "node:test"
import { loadConfig } from "../src/config.js"
import {
  approvalOperationId,
  canonicalApprovalJson,
  canonicalReceiptJson,
  createReceipt,
  parseMatchingReceipt,
  readApproval,
} from "../src/notion.js"
import { executeApprovedTransition } from "../src/transition.js"
import type {
  ApprovalAction,
  ApprovalSnapshot,
  NotionClientLike,
  ProductionObservation,
  TransitionAction,
  TransitionInput,
  TransitionReceipt,
  VercelClientLike,
  VercelDeployment,
  WorkerConfig,
} from "../src/types.js"
import { SafetyError, VercelHttpError } from "../src/types.js"

const PAGE_ID = "11111111-1111-4111-8111-111111111111"
const PARENT_ID = "22222222-2222-4222-8222-222222222222"
const TEAM_ID = "team_acme"
const PROJECT_ID = "prj_checkout"
const EXPECTED_ID = "dpl_previous"
const TARGET_ID = "dpl_candidate"
const GIT_SHA = "a".repeat(40)
const NOW = new Date("2026-07-04T14:00:00.000Z")

const config: WorkerConfig = {
  vercelToken: "vercel-secret",
  teamId: TEAM_ID,
  projectId: PROJECT_ID,
  productionDomains: ["app.example.com", "www.example.com"],
  deploymentCheckIds: ["check_integration"],
  healthPaths: ["/healthz"],
  approvalParentId: PARENT_ID.replaceAll("-", ""),
  protectionBypassSecret: null,
}

function richText(value: string): Record<string, unknown> {
  return {
    type: "rich_text",
    rich_text: value ? [{ type: "text", plain_text: value }] : [],
  }
}

class FakeNotion implements NotionClientLike {
  pageId = PAGE_ID
  parentId = PARENT_ID
  parentType: "data_source_id" | "database_id" = "data_source_id"
  status = "Approved"
  action: ApprovalAction = "Promote"
  revision = "release-42"
  teamId = TEAM_ID
  projectId = PROJECT_ID
  expectedCurrentDeploymentId = EXPECTED_ID
  targetDeploymentId = TARGET_ID
  gitSha = GIT_SHA
  receipt = ""
  retrieves = 0
  updates = 0
  failUpdateAt = new Set<number>()
  dropWriteAt = new Set<number>()
  propertyOverrides: Record<string, unknown> = {}
  retrieveHook: ((call: number, notion: FakeNotion) => void) | null = null

  pages: NotionClientLike["pages"] = {
    retrieve: async ({ page_id }) => {
      assert.equal(page_id, this.pageId)
      this.retrieves++
      this.retrieveHook?.(this.retrieves, this)
      return {
        object: "page",
        id: this.pageId,
        archived: false,
        in_trash: false,
        parent: { type: this.parentType, [this.parentType]: this.parentId },
        properties: {
          "Approval status": {
            type: "status",
            status: { name: this.status },
          },
          Action: { type: "select", select: { name: this.action } },
          "Approval revision": richText(this.revision),
          "Vercel team ID": richText(this.teamId),
          "Vercel project ID": richText(this.projectId),
          "Expected current deployment ID": richText(
            this.expectedCurrentDeploymentId
          ),
          "Target deployment ID": richText(this.targetDeploymentId),
          "Git SHA": richText(this.gitSha),
          "Worker receipt": richText(this.receipt),
          ...this.propertyOverrides,
        },
      }
    },
    update: async ({ page_id, properties }) => {
      assert.equal(page_id, this.pageId)
      this.updates++
      if (this.failUpdateAt.has(this.updates)) {
        throw new Error("mock Notion write failure")
      }
      const property = properties["Worker receipt"] as {
        rich_text: { text: { content: string } }[]
      }
      assert.ok(property)
      if (!this.dropWriteAt.has(this.updates)) {
        this.receipt = property.rich_text[0]?.text.content ?? ""
      }
      return { object: "page", id: this.pageId }
    },
  }

  approvalWithoutReceipt(): Omit<ApprovalSnapshot, "receipt"> {
    const base = {
      pageId: this.pageId,
      action: this.action,
      revision: this.revision,
      teamId: this.teamId,
      projectId: this.projectId,
      expectedCurrentDeploymentId: this.expectedCurrentDeploymentId,
      targetDeploymentId: this.targetDeploymentId,
      gitSha: this.gitSha,
    }
    return { ...base, operationId: approvalOperationId(base) }
  }

  setReceipt(state: TransitionReceipt["state"]): void {
    this.receipt = canonicalReceiptJson(
      createReceipt(this.approvalWithoutReceipt(), state, NOW)
    )
  }

  receiptState(): TransitionReceipt["state"] | null {
    if (!this.receipt) return null
    return (JSON.parse(this.receipt) as TransitionReceipt).state
  }
}

type RequestMode = "accepted" | "ambiguous" | "rejected"

class FakeVercel implements VercelClientLike {
  productionId: string | null = EXPECTED_ID
  exactDomainSet = true
  customDomainDeploymentIds: Record<string, string | null> | null = null
  requestMode: RequestMode = "accepted"
  ambiguousRequestChangesProduction = false
  rollingFailures = new Map<number, Error>()
  verifyFailures = new Map<number, Error>()
  directHealthFailures = new Map<number, Error>()
  productionHealthFailures = new Map<number, Error>()
  observeHook: ((call: number, vercel: FakeVercel) => void) | null = null

  rollingCalls = 0
  verifyCalls = 0
  checkCalls = 0
  observeCalls = 0
  directHealthCalls = 0
  productionHealthCalls = 0
  expectedStates: ("staged" | "promoted")[] = []
  requestCalls: {
    action: TransitionAction
    teamId: string
    projectId: string
    targetDeploymentId: string
  }[] = []
  directHealthArguments: { hostname: string; paths: string[] }[] = []
  productionHealthArguments: { domains: string[]; paths: string[] }[] = []

  async assertRollingReleasesDisabled(
    teamId: string,
    projectId: string
  ): Promise<void> {
    assert.equal(teamId, TEAM_ID)
    assert.equal(projectId, PROJECT_ID)
    this.rollingCalls++
    const failure = this.rollingFailures.get(this.rollingCalls)
    if (failure) throw failure
  }

  async verifyDeployment(
    teamId: string,
    projectId: string,
    deploymentId: string,
    expectedGitSha: string,
    expectedState: "staged" | "promoted"
  ): Promise<VercelDeployment> {
    this.verifyCalls++
    this.expectedStates.push(expectedState)
    const failure = this.verifyFailures.get(this.verifyCalls)
    if (failure) throw failure
    assert.equal(expectedGitSha, GIT_SHA)
    return this.deployment(teamId, projectId, deploymentId)
  }

  private deployment(
    teamId: string,
    projectId: string,
    deploymentId: string
  ): VercelDeployment {
    return {
      id: deploymentId,
      teamId,
      projectId,
      url: "candidate.vercel.app",
      readyState: "READY",
      gitSha: GIT_SHA,
    }
  }

  async verifyDeploymentChecks(
    teamId: string,
    projectId: string,
    deploymentId: string,
    requiredCheckIds: string[]
  ): Promise<void> {
    assert.equal(teamId, TEAM_ID)
    assert.equal(projectId, PROJECT_ID)
    assert.equal(deploymentId, TARGET_ID)
    assert.deepEqual(requiredCheckIds, config.deploymentCheckIds)
    this.checkCalls++
  }

  async observeProduction(
    teamId: string,
    projectId: string,
    productionDomains: string[]
  ): Promise<ProductionObservation> {
    assert.equal(teamId, TEAM_ID)
    assert.equal(projectId, PROJECT_ID)
    assert.deepEqual(productionDomains, config.productionDomains)
    this.observeCalls++
    this.observeHook?.(this.observeCalls, this)
    return {
      currentDeploymentId: this.productionId,
      exactDomainSet: this.exactDomainSet,
      domainDeploymentIds:
        this.customDomainDeploymentIds ??
        Object.fromEntries(
          productionDomains.map((domain) => [domain, this.productionId])
        ),
    }
  }

  async checkDeploymentHealth(
    hostname: string,
    paths: string[]
  ): Promise<void> {
    this.directHealthCalls++
    this.directHealthArguments.push({ hostname, paths: [...paths] })
    const failure = this.directHealthFailures.get(this.directHealthCalls)
    if (failure) throw failure
  }

  async checkProductionHealth(
    domains: string[],
    paths: string[]
  ): Promise<void> {
    this.productionHealthCalls++
    this.productionHealthArguments.push({
      domains: [...domains],
      paths: [...paths],
    })
    const failure = this.productionHealthFailures.get(
      this.productionHealthCalls
    )
    if (failure) throw failure
  }

  async requestTransition(
    action: TransitionAction,
    teamId: string,
    projectId: string,
    targetDeploymentId: string
  ): Promise<void> {
    this.requestCalls.push({ action, teamId, projectId, targetDeploymentId })
    if (this.requestMode === "rejected") {
      throw new VercelHttpError("Vercel rejected the request.", {
        status: 400,
        ambiguous: false,
      })
    }
    if (this.requestMode === "ambiguous") {
      if (this.ambiguousRequestChangesProduction) {
        this.productionId = targetDeploymentId
      }
      throw new VercelHttpError("The request outcome is unknown.", {
        ambiguous: true,
      })
    }
    this.productionId = targetDeploymentId
  }
}

async function run(
  action: TransitionAction,
  notion: FakeNotion,
  vercel: FakeVercel,
  input: TransitionInput = { approvalPageId: PAGE_ID }
) {
  const sleeps: number[] = []
  const value = await executeApprovedTransition(action, input, config, {
    notion,
    vercel,
    now: () => NOW,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds)
    },
  })
  return { value, sleeps }
}

for (const action of ["promote", "rollback"] as const) {
  test(`${action} follows the compact shared happy path`, async () => {
    const notion = new FakeNotion()
    notion.action = action === "promote" ? "Promote" : "Rollback"
    const vercel = new FakeVercel()

    const { value } = await run(action, notion, vercel)

    assert.equal(value.ok, true)
    assert.equal(value.status, "completed")
    assert.equal(value.action, action)
    assert.equal(value.changed, true)
    assert.equal(value.requestAttempted, true)
    assert.equal(value.receiptState, "completed")
    assert.equal(value.currentDeploymentId, TARGET_ID)
    assert.equal(notion.receiptState(), "completed")
    assert.equal(notion.retrieves, 7)
    assert.equal(notion.updates, 2)
    assert.equal(vercel.rollingCalls, 3)
    assert.equal(vercel.verifyCalls, 2)
    assert.deepEqual(vercel.expectedStates, [
      action === "promote" ? "staged" : "promoted",
      action === "promote" ? "staged" : "promoted",
    ])
    assert.equal(vercel.checkCalls, action === "promote" ? 2 : 0)
    assert.equal(vercel.directHealthCalls, 2)
    assert.deepEqual(vercel.directHealthArguments, [
      { hostname: "candidate.vercel.app", paths: ["/healthz"] },
      { hostname: "candidate.vercel.app", paths: ["/healthz"] },
    ])
    assert.deepEqual(vercel.productionHealthArguments, [
      {
        domains: ["app.example.com", "www.example.com"],
        paths: ["/healthz"],
      },
    ])
    assert.deepEqual(vercel.requestCalls, [
      {
        action,
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        targetDeploymentId: TARGET_ID,
      },
    ])
  })
}

test("the page is the only caller-supplied authority and its configured parent is enforced", async () => {
  const notion = new FakeNotion()
  const vercel = new FakeVercel()
  const forgedInput = {
    approvalPageId: PAGE_ID,
    teamId: "team_attacker",
    projectId: "prj_attacker",
    targetDeploymentId: "dpl_attacker",
  } as unknown as TransitionInput

  const { value } = await run("promote", notion, vercel, forgedInput)
  assert.equal(value.status, "completed")
  assert.deepEqual(vercel.requestCalls[0], {
    action: "promote",
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    targetDeploymentId: TARGET_ID,
  })

  const wrongParent = new FakeNotion()
  wrongParent.parentId = "33333333-3333-4333-8333-333333333333"
  const blockedVercel = new FakeVercel()
  const blocked = await run("promote", wrongParent, blockedVercel)
  assert.equal(blocked.value.status, "blocked")
  assert.match(blocked.value.message, /APPROVAL_PARENT_MISMATCH/)
  assert.equal(blockedVercel.requestCalls.length, 0)
})

test("project, action, status, and schema mismatches fail before provider reads", async (t) => {
  const cases: [string, (notion: FakeNotion) => void][] = [
    ["project", (notion) => (notion.projectId = "prj_other")],
    ["action", (notion) => (notion.action = "Rollback")],
    ["status", (notion) => (notion.status = "Pending")],
    ["schema", (notion) => (notion.targetDeploymentId = "not-a-deployment")],
  ]
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const notion = new FakeNotion()
      mutate(notion)
      const vercel = new FakeVercel()
      const { value } = await run("promote", notion, vercel)
      assert.equal(value.status, "blocked")
      assert.equal(value.requestAttempted, false)
      assert.equal(vercel.observeCalls, 0)
      assert.equal(vercel.requestCalls.length, 0)
    })
  }
})

test("a completed receipt is a health-checked no-op", async () => {
  const notion = new FakeNotion()
  notion.setReceipt("completed")
  const vercel = new FakeVercel()
  vercel.productionId = TARGET_ID

  const { value } = await run("promote", notion, vercel)

  assert.equal(value.status, "no_op")
  assert.equal(value.changed, false)
  assert.equal(value.requestAttempted, false)
  assert.equal(value.receiptState, "completed")
  assert.equal(vercel.requestCalls.length, 0)
  assert.equal(vercel.verifyCalls, 0)
  assert.equal(vercel.directHealthCalls, 0)
  assert.equal(vercel.productionHealthCalls, 1)
})

test("request_started reconciles and completes without another POST", async () => {
  const notion = new FakeNotion()
  notion.setReceipt("request_started")
  const vercel = new FakeVercel()
  vercel.productionId = TARGET_ID

  const { value } = await run("promote", notion, vercel)

  assert.equal(value.status, "no_op")
  assert.equal(value.requestAttempted, false)
  assert.equal(value.changed, false)
  assert.equal(notion.receiptState(), "completed")
  assert.equal(vercel.requestCalls.length, 0)
  assert.equal(vercel.verifyCalls, 0)
  assert.equal(vercel.productionHealthCalls, 1)
})

test("an ambiguous transport outcome is never reposted", async () => {
  const notion = new FakeNotion()
  const vercel = new FakeVercel()
  vercel.requestMode = "ambiguous"

  const first = await run("promote", notion, vercel)
  assert.equal(first.value.status, "ambiguous")
  assert.equal(first.value.requestAttempted, true)
  assert.equal(first.value.changed, false)
  assert.equal(first.value.currentDeploymentId, EXPECTED_ID)
  assert.equal(notion.receiptState(), "request_started")
  assert.equal(vercel.requestCalls.length, 1)
  assert.deepEqual(first.sleeps, [1_000, 1_000])

  vercel.productionId = TARGET_ID
  const second = await run("promote", notion, vercel)
  assert.equal(second.value.status, "no_op")
  assert.equal(second.value.requestAttempted, false)
  assert.equal(notion.receiptState(), "completed")
  assert.equal(vercel.requestCalls.length, 1)
})

test("a definite rejection is recorded and blocks reuse", async () => {
  const notion = new FakeNotion()
  const vercel = new FakeVercel()
  vercel.requestMode = "rejected"

  const first = await run("promote", notion, vercel)
  assert.equal(first.value.status, "blocked")
  assert.equal(first.value.requestAttempted, true)
  assert.equal(notion.receiptState(), "rejected")
  assert.equal(vercel.requestCalls.length, 1)

  const second = await run("promote", notion, vercel)
  assert.equal(second.value.status, "blocked")
  assert.equal(second.value.requestAttempted, false)
  assert.equal(vercel.requestCalls.length, 1)
})

test("a target already serving production is adopted without a POST", async () => {
  const notion = new FakeNotion()
  const vercel = new FakeVercel()
  vercel.productionId = TARGET_ID

  const { value } = await run("promote", notion, vercel)

  assert.equal(value.status, "no_op")
  assert.equal(value.changed, false)
  assert.equal(value.requestAttempted, false)
  assert.equal(value.currentDeploymentId, TARGET_ID)
  assert.equal(notion.receiptState(), "completed")
  assert.equal(vercel.requestCalls.length, 0)
  assert.equal(vercel.verifyCalls, 1)
  assert.equal(vercel.productionHealthCalls, 1)
})

test("split and unexpected production routing are conflicts", async (t) => {
  for (const state of ["split", "other"] as const) {
    await t.test(state, async () => {
      const notion = new FakeNotion()
      const vercel = new FakeVercel()
      if (state === "split") {
        vercel.exactDomainSet = false
        vercel.customDomainDeploymentIds = {
          "app.example.com": EXPECTED_ID,
          "www.example.com": TARGET_ID,
        }
      } else {
        vercel.productionId = "dpl_unexpected"
      }

      const { value } = await run("promote", notion, vercel)
      assert.equal(value.status, "conflict")
      assert.equal(value.requestAttempted, false)
      assert.equal(notion.updates, 0)
      assert.equal(vercel.requestCalls.length, 0)
    })
  }
})

test("a boundary receipt write failure prevents the provider request", async () => {
  const notion = new FakeNotion()
  notion.failUpdateAt.add(1)
  const vercel = new FakeVercel()

  const { value } = await run("promote", notion, vercel)

  assert.equal(value.status, "blocked")
  assert.equal(value.requestAttempted, false)
  assert.equal(value.receiptState, "none")
  assert.equal(vercel.requestCalls.length, 0)
})

for (const failure of ["write", "readback"] as const) {
  test(`a completed-receipt ${failure} failure remains recoverable without a repost`, async () => {
    const notion = new FakeNotion()
    if (failure === "write") notion.failUpdateAt.add(2)
    else notion.dropWriteAt.add(2)
    const vercel = new FakeVercel()

    const first = await run("promote", notion, vercel)
    assert.equal(first.value.status, "ambiguous")
    assert.equal(first.value.requestAttempted, true)
    assert.equal(first.value.currentDeploymentId, TARGET_ID)
    assert.equal(notion.receiptState(), "request_started")
    assert.equal(vercel.requestCalls.length, 1)

    notion.failUpdateAt.clear()
    notion.dropWriteAt.clear()
    const second = await run("promote", notion, vercel)
    assert.equal(second.value.status, "no_op")
    assert.equal(notion.receiptState(), "completed")
    assert.equal(vercel.requestCalls.length, 1)
  })
}

test("approval revision drift during preflight blocks the request", async () => {
  const notion = new FakeNotion()
  notion.retrieveHook = (call, value) => {
    if (call === 2) value.revision = "release-43"
  }
  const vercel = new FakeVercel()

  const { value } = await run("promote", notion, vercel)

  assert.equal(value.status, "blocked")
  assert.match(value.message, /APPROVAL_CHANGED/)
  assert.equal(notion.updates, 0)
  assert.equal(vercel.requestCalls.length, 0)
})

test("rolling-release failures fail closed on every provider guard", async (t) => {
  for (const call of [1, 2, 3]) {
    await t.test(`provider read ${call}`, async () => {
      const notion = new FakeNotion()
      const vercel = new FakeVercel()
      vercel.rollingFailures.set(
        call,
        new SafetyError(
          "ROLLING_RELEASE_ACTIVE",
          "Rolling releases must be disabled."
        )
      )

      const { value } = await run("promote", notion, vercel)
      assert.equal(value.status, "blocked")
      assert.match(value.message, /ROLLING_RELEASE_ACTIVE/)
      assert.equal(notion.updates, call === 3 ? 2 : 0)
      assert.equal(value.receiptState, call === 3 ? "cancelled" : "none")
      assert.equal(vercel.requestCalls.length, 0)
    })
  }
})

test("the final routing guard cancels a stale approval without a POST", async () => {
  const notion = new FakeNotion()
  const vercel = new FakeVercel()
  vercel.observeHook = (call, value) => {
    if (call === 3) value.productionId = "dpl_other"
  }

  const { value } = await run("promote", notion, vercel)
  assert.equal(value.status, "conflict")
  assert.equal(value.requestAttempted, false)
  assert.equal(value.receiptState, "cancelled")
  assert.equal(vercel.requestCalls.length, 0)
})

test("the request boundary must survive its final readback before POST", async () => {
  const notion = new FakeNotion()
  notion.retrieveHook = (call, value) => {
    if (call === 5) value.receipt = ""
  }
  const vercel = new FakeVercel()

  const { value } = await run("promote", notion, vercel)
  assert.equal(value.status, "blocked")
  assert.match(value.message, /RECEIPT_BOUNDARY_CHANGED/)
  assert.equal(value.requestAttempted, false)
  assert.equal(vercel.requestCalls.length, 0)
})

test("post-transition health covers every fixed domain before completion", async () => {
  const notion = new FakeNotion()
  const vercel = new FakeVercel()
  vercel.productionHealthFailures.set(
    1,
    new SafetyError("HEALTH_FAILED", "A production health check failed.")
  )

  const first = await run("promote", notion, vercel)
  assert.equal(first.value.status, "ambiguous")
  assert.equal(first.value.requestAttempted, true)
  assert.equal(first.value.changed, true)
  assert.equal(first.value.currentDeploymentId, TARGET_ID)
  assert.deepEqual(vercel.productionHealthArguments[0], {
    domains: config.productionDomains,
    paths: config.healthPaths,
  })
  assert.equal(notion.receiptState(), "request_started")
  assert.equal(vercel.requestCalls.length, 1)

  vercel.productionHealthFailures.clear()
  const second = await run("promote", notion, vercel)
  assert.equal(second.value.status, "no_op")
  assert.equal(vercel.requestCalls.length, 1)
})

test("malicious and oversized caller or page data produce bounded results", async (t) => {
  const inputs = [
    `<script>${"x".repeat(1_000_000)}`,
    "not-a-uuid\u0000provider-secret",
  ]
  for (const approvalPageId of inputs) {
    await t.test("caller input", async () => {
      const notion = new FakeNotion()
      const vercel = new FakeVercel()
      const { value } = await run("rollback", notion, vercel, {
        approvalPageId,
      })
      const encoded = JSON.stringify(value)
      assert.equal(value.status, "blocked")
      assert.ok(encoded.length < 2_000)
      assert.doesNotMatch(encoded, /<script>|provider-secret|x{100}/)
      assert.equal(notion.retrieves, 0)
    })
  }

  await t.test("oversized Notion property", async () => {
    const notion = new FakeNotion()
    notion.revision = `secret-${"z".repeat(1_000_000)}`
    const vercel = new FakeVercel()
    const { value } = await run("promote", notion, vercel)
    const encoded = JSON.stringify(value)
    assert.equal(value.status, "blocked")
    assert.ok(encoded.length < 2_000)
    assert.doesNotMatch(encoded, /secret-|z{100}/)
    assert.equal(vercel.requestCalls.length, 0)
  })

  await t.test("oversized receipt", async () => {
    const notion = new FakeNotion()
    notion.receipt = "r".repeat(2_000)
    const vercel = new FakeVercel()
    const { value } = await run("promote", notion, vercel)
    const encoded = JSON.stringify(value)
    assert.equal(value.status, "blocked")
    assert.ok(encoded.length < 2_000)
    assert.doesNotMatch(encoded, /r{100}/)
  })
})

test("configuration is canonical and bounded", () => {
  const env = {
    VERCEL_ACCESS_TOKEN: "token",
    VERCEL_TEAM_ID: TEAM_ID,
    VERCEL_PROJECT_ID: PROJECT_ID,
    VERCEL_PRODUCTION_DOMAINS_JSON: JSON.stringify([
      "www.example.com",
      "app.example.com",
    ]),
    VERCEL_DEPLOYMENT_CHECK_IDS_JSON: JSON.stringify(["check_integration"]),
    VERCEL_HEALTH_PATHS_JSON: JSON.stringify(["/healthz"]),
    NOTION_VERCEL_APPROVAL_PARENT_ID: PARENT_ID,
  }
  const loaded = loadConfig(env)
  assert.deepEqual(loaded.productionDomains, [
    "app.example.com",
    "www.example.com",
  ])
  assert.equal(loaded.approvalParentId, PARENT_ID.replaceAll("-", ""))

  assert.throws(
    () =>
      loadConfig({
        ...env,
        VERCEL_PRODUCTION_DOMAINS_JSON: JSON.stringify(
          Array.from({ length: 6 }, (_, index) => `d${index}.example.com`)
        ),
      }),
    (error: unknown) =>
      error instanceof SafetyError && error.code === "CONFIGURATION"
  )
  assert.throws(
    () =>
      loadConfig({
        ...env,
        VERCEL_HEALTH_PATHS_JSON: JSON.stringify(["/../admin"]),
      }),
    (error: unknown) =>
      error instanceof SafetyError && error.code === "CONFIGURATION"
  )
})

test("canonical operation and receipt encoding reject drift and forgery", () => {
  const notion = new FakeNotion()
  const approval = notion.approvalWithoutReceipt()
  const canonical = canonicalApprovalJson(approval)
  assert.deepEqual(Object.keys(JSON.parse(canonical) as object), [
    "version",
    "action",
    "teamId",
    "projectId",
    "expectedCurrentDeploymentId",
    "targetDeploymentId",
    "gitSha",
  ])

  const replacement = { ...approval, pageId: "other", revision: "release-43" }
  assert.equal(approvalOperationId(replacement), approval.operationId)
  assert.notEqual(
    approvalOperationId({ ...approval, targetDeploymentId: "dpl_other" }),
    approval.operationId
  )

  const receipt = createReceipt(approval, "request_started", NOW)
  const encoded = canonicalReceiptJson(receipt)
  assert.deepEqual(parseMatchingReceipt(encoded, approval), receipt)
  assert.throws(
    () =>
      parseMatchingReceipt(
        JSON.stringify({ ...receipt, unexpected: "forged" }),
        approval
      ),
    (error: unknown) =>
      error instanceof SafetyError && error.code === "RECEIPT_INVALID"
  )
  assert.throws(
    () =>
      parseMatchingReceipt(encoded, { ...approval, revision: "release-43" }),
    (error: unknown) =>
      error instanceof SafetyError && error.code === "RECEIPT_MISMATCH"
  )
})

test("Notion reads canonical approvals from data-source or legacy database parents", async () => {
  for (const parentType of ["data_source_id", "database_id"] as const) {
    const notion = new FakeNotion()
    notion.parentType = parentType
    const approval = await readApproval(notion, {
      pageId: PAGE_ID,
      parentId: config.approvalParentId,
      expectedAction: "promote",
    })
    assert.equal(
      approval.operationId,
      notion.approvalWithoutReceipt().operationId
    )
    assert.equal(approval.receipt, null)
  }
})
