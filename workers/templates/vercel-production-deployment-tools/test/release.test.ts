import assert from "node:assert/strict"
import test from "node:test"
import { executeTransition, inspectProductionChange } from "../src/release.js"
import type {
  ProductionObservation,
  RollingReleaseState,
  TransitionAction,
  VercelClientLike,
  VercelDeployment,
  WorkerConfig,
} from "../src/types.js"
import { SafetyError, VercelHttpError } from "../src/types.js"

const TEAM = "team_acme"
const PROJECT = "prj_checkout"
const TARGET = "dpl_target"
const CURRENT = "dpl_current"
const OTHER = "dpl_other"
const SHA = "a".repeat(40)

const config: WorkerConfig = {
  vercelToken: "secret",
  teamId: TEAM,
  projectId: PROJECT,
  healthPaths: [],
  protectionBypassSecret: null,
}

function deployment(
  overrides: Partial<VercelDeployment> = {}
): VercelDeployment {
  return {
    id: TARGET,
    projectId: PROJECT,
    teamId: TEAM,
    url: "checkout-target.vercel.app",
    target: "production",
    readyState: "READY",
    readySubstate: "STAGED",
    gitSha: SHA,
    checksState: "completed",
    checksConclusion: "succeeded",
    ...overrides,
  }
}

function production(
  currentDeploymentId: string | null = CURRENT
): ProductionObservation {
  const domainDeploymentIds =
    currentDeploymentId === null
      ? {
          "checkout.example.com": CURRENT,
          "www.example.com": TARGET,
        }
      : {
          "checkout.example.com": currentDeploymentId,
          "www.example.com": currentDeploymentId,
        }
  return {
    currentDeploymentId,
    domainDeploymentIds,
    productionDomains: Object.keys(domainDeploymentIds),
  }
}

function productionWithDomains(count: number): ProductionObservation {
  const domainDeploymentIds = Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `app-${index}.example.com`,
      CURRENT,
    ])
  )
  return {
    currentDeploymentId: CURRENT,
    domainDeploymentIds,
    productionDomains: Object.keys(domainDeploymentIds),
  }
}

class FakeVercel implements VercelClientLike {
  deployments: VercelDeployment[] = [deployment()]
  productions: ProductionObservation[] = [production()]
  rollingRelease: RollingReleaseState = "none"
  rollingReleases: RollingReleaseState[] = []
  requestError: Error | null = null
  deploymentHealthError: Error | null = null
  productionHealthError: Error | null = null
  requests: TransitionAction[] = []
  deploymentReads = 0
  rollingReads = 0
  deploymentHealthChecks = 0
  productionHealthChecks = 0

  async getDeployment() {
    this.deploymentReads++
    return this.deployments.length > 1
      ? this.deployments.shift()!
      : this.deployments[0]
  }

  async getRollingReleaseState() {
    this.rollingReads++
    return this.rollingReleases.length > 0
      ? this.rollingReleases.shift()!
      : this.rollingRelease
  }

  async observeProduction() {
    return this.productions.length > 1
      ? this.productions.shift()!
      : this.productions[0]
  }

  async checkDeploymentHealth() {
    this.deploymentHealthChecks++
    if (this.deploymentHealthError) throw this.deploymentHealthError
  }

  async checkProductionHealth() {
    this.productionHealthChecks++
    if (this.productionHealthError) throw this.productionHealthError
  }

  async requestTransition(action: TransitionAction) {
    this.requests.push(action)
    if (this.requestError) throw this.requestError
  }
}

function dependencies(vercel: FakeVercel) {
  const sleeps: number[] = []
  return {
    value: {
      vercel,
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds)
      },
    },
    sleeps,
  }
}

test("inspection returns live Vercel identity, checks, domains, and current guard", async () => {
  const vercel = new FakeVercel()
  const result = await inspectProductionChange(
    { action: "promote", targetDeploymentId: TARGET },
    { ...config, healthPaths: ["/healthz"] },
    dependencies(vercel).value
  )

  assert.deepEqual(result, {
    ok: true,
    status: "ready",
    action: "promote",
    targetDeploymentId: TARGET,
    targetUrl: "checkout-target.vercel.app",
    expectedGitSha: SHA,
    targetReadySubstate: "STAGED",
    expectedCurrentDeploymentId: CURRENT,
    productionDomains: ["checkout.example.com", "www.example.com"],
    deploymentChecks: "passed",
    warning: null,
    message: "The staged Production deployment is ready to promote.",
  })
  assert.equal(vercel.deploymentHealthChecks, 1)
  assert.deepEqual(vercel.requests, [])
})

test("rollback inspection reads Rolling Release state and explains consequences", async () => {
  const vercel = new FakeVercel()
  vercel.deployments = [
    deployment({
      readySubstate: "PROMOTED",
      checksState: null,
      checksConclusion: null,
    }),
  ]
  const result = await inspectProductionChange(
    { action: "rollback", targetDeploymentId: TARGET },
    config,
    dependencies(vercel).value
  )

  assert.equal(result.status, "ready")
  assert.equal(result.deploymentChecks, "not_reported")
  assert.match(result.warning ?? "", /previous build/)
  assert.match(result.warning ?? "", /automatic Production-domain assignment/)
  assert.equal(vercel.rollingReads, 1)
})

test("inspection blocks failed checks, unsupported promotions, and split routing", async () => {
  const cases: Array<{
    configure(vercel: FakeVercel): void
    code: string
    status?: "blocked" | "conflict"
  }> = [
    {
      configure(vercel) {
        vercel.deployments = [
          deployment({ checksState: "running", checksConclusion: null }),
        ]
      },
      code: "DEPLOYMENT_CHECKS_BLOCKED",
    },
    {
      configure(vercel) {
        vercel.rollingRelease = "configured"
      },
      code: "ROLLING_RELEASE_UNSUPPORTED",
    },
    {
      configure(vercel) {
        vercel.productions = [production(null)]
      },
      code: "PRODUCTION_SPLIT",
      status: "conflict",
    },
  ]

  for (const item of cases) {
    const vercel = new FakeVercel()
    item.configure(vercel)
    const result = await inspectProductionChange(
      { action: "promote", targetDeploymentId: TARGET },
      config,
      dependencies(vercel).value
    )
    assert.equal(result.status, item.status ?? "blocked")
    assert.match(result.message, new RegExp(item.code))
    assert.deepEqual(vercel.requests, [])
  }
})

test("invalid input is rejected without echoing an unbounded deployment ID", async () => {
  const targetDeploymentId = `not-a-deployment-${"x".repeat(1_000)}`
  const result = await inspectProductionChange(
    { action: "promote", targetDeploymentId },
    config,
    dependencies(new FakeVercel()).value
  )

  assert.equal(result.status, "blocked")
  assert.equal(result.targetDeploymentId, "invalid")
})

test("optional health fan-out is rejected before a write", async () => {
  const vercel = new FakeVercel()
  vercel.productions = [productionWithDomains(11)]
  const healthConfig = { ...config, healthPaths: ["/healthz"] }

  const inspection = await inspectProductionChange(
    { action: "promote", targetDeploymentId: TARGET },
    healthConfig,
    dependencies(vercel).value
  )
  assert.equal(inspection.status, "blocked")
  assert.match(inspection.message, /HEALTH_FANOUT_UNSUPPORTED/)

  const result = await executeTransition(
    "promote",
    {
      targetDeploymentId: TARGET,
      expectedCurrentDeploymentId: CURRENT,
      expectedGitSha: SHA,
    },
    healthConfig,
    dependencies(vercel).value
  )
  assert.equal(result.status, "blocked")
  assert.deepEqual(vercel.requests, [])

  const withoutHealth = new FakeVercel()
  withoutHealth.productions = [productionWithDomains(11)]
  assert.equal(
    (
      await inspectProductionChange(
        { action: "promote", targetDeploymentId: TARGET },
        config,
        dependencies(withoutHealth).value
      )
    ).status,
    "ready"
  )
})

test("an already-live target is a healthy no-op", async () => {
  const vercel = new FakeVercel()
  vercel.productions = [production(TARGET)]
  vercel.deployments = [deployment({ readySubstate: "PROMOTED" })]

  const result = await executeTransition(
    "promote",
    {
      targetDeploymentId: TARGET,
      expectedCurrentDeploymentId: TARGET,
      expectedGitSha: SHA,
    },
    config,
    dependencies(vercel).value
  )

  assert.equal(result.status, "no_op")
  assert.equal(result.requestAttempted, false)
  assert.equal(vercel.productionHealthChecks, 1)
  assert.deepEqual(vercel.requests, [])
})

test("rollback aborts an active Rolling Release even when the target owns the aliases", async () => {
  const vercel = new FakeVercel()
  const target = deployment({ readySubstate: "PROMOTED" })
  vercel.deployments = [target, target]
  vercel.productions = [production(TARGET)]
  vercel.rollingReleases = ["active", "active", "active", "configured"]

  const inspection = await inspectProductionChange(
    { action: "rollback", targetDeploymentId: TARGET },
    config,
    dependencies(vercel).value
  )
  assert.equal(inspection.status, "ready")
  assert.match(inspection.warning ?? "", /stop the active Rolling Release/)

  const result = await executeTransition(
    "rollback",
    {
      targetDeploymentId: TARGET,
      expectedCurrentDeploymentId: TARGET,
      expectedGitSha: SHA,
    },
    config,
    dependencies(vercel).value
  )

  assert.equal(result.status, "completed")
  assert.deepEqual(vercel.requests, ["rollback"])
  assert.equal(vercel.rollingReads, 4)
})

test("write tools reject stale current and Git assertions before POST", async () => {
  const staleCurrent = new FakeVercel()
  let result = await executeTransition(
    "promote",
    {
      targetDeploymentId: TARGET,
      expectedCurrentDeploymentId: OTHER,
      expectedGitSha: SHA,
    },
    config,
    dependencies(staleCurrent).value
  )
  assert.equal(result.status, "conflict")
  assert.deepEqual(staleCurrent.requests, [])

  const staleSha = new FakeVercel()
  result = await executeTransition(
    "promote",
    {
      targetDeploymentId: TARGET,
      expectedCurrentDeploymentId: CURRENT,
      expectedGitSha: "b".repeat(40),
    },
    config,
    dependencies(staleSha).value
  )
  assert.equal(result.status, "conflict")
  assert.deepEqual(staleSha.requests, [])
})

test("release tools recheck state, send one request, and reconcile", async () => {
  for (const action of ["promote", "rollback"] as const) {
    const vercel = new FakeVercel()
    const target = deployment({
      readySubstate: action === "promote" ? "STAGED" : "PROMOTED",
    })
    vercel.deployments = [target, target]
    vercel.productions = [
      production(CURRENT),
      production(CURRENT),
      production(TARGET),
    ]
    const result = await executeTransition(
      action,
      {
        targetDeploymentId: TARGET,
        expectedCurrentDeploymentId: CURRENT,
        expectedGitSha: SHA,
      },
      { ...config, healthPaths: ["/healthz"] },
      dependencies(vercel).value
    )

    assert.equal(result.status, "completed")
    assert.deepEqual(vercel.requests, [action])
    assert.equal(vercel.deploymentReads, 2)
    assert.equal(vercel.deploymentHealthChecks, 1)
    assert.equal(vercel.productionHealthChecks, 1)
    assert.equal(vercel.rollingReads, 2)
  }
})

test("a final preflight change prevents the POST", async () => {
  const vercel = new FakeVercel()
  vercel.productions = [production(CURRENT), production(OTHER)]
  const result = await executeTransition(
    "promote",
    {
      targetDeploymentId: TARGET,
      expectedCurrentDeploymentId: CURRENT,
      expectedGitSha: SHA,
    },
    config,
    dependencies(vercel).value
  )

  assert.equal(result.status, "conflict")
  assert.deepEqual(vercel.requests, [])
})

test("a lost mutation response is never reposted and becomes ambiguous", async () => {
  const vercel = new FakeVercel()
  vercel.productions = [production(CURRENT), production(CURRENT)]
  vercel.requestError = new VercelHttpError("socket lost", {
    ambiguous: true,
  })
  const { value, sleeps } = dependencies(vercel)
  const result = await executeTransition(
    "promote",
    {
      targetDeploymentId: TARGET,
      expectedCurrentDeploymentId: CURRENT,
      expectedGitSha: SHA,
    },
    config,
    value
  )

  assert.equal(result.status, "ambiguous")
  assert.equal(result.requestAttempted, true)
  assert.deepEqual(vercel.requests, ["promote"])
  assert.equal(sleeps.length, 5)
  assert.match(result.nextStep ?? "", /Do not repeat/)
})

test("a definite Vercel rejection is blocked without polling or reposting", async () => {
  const vercel = new FakeVercel()
  vercel.productions = [production(CURRENT), production(CURRENT)]
  vercel.requestError = new VercelHttpError("conflict", {
    status: 409,
    ambiguous: false,
  })
  const { value, sleeps } = dependencies(vercel)
  const result = await executeTransition(
    "promote",
    {
      targetDeploymentId: TARGET,
      expectedCurrentDeploymentId: CURRENT,
      expectedGitSha: null,
    },
    config,
    value
  )

  assert.equal(result.status, "blocked")
  assert.deepEqual(vercel.requests, ["promote"])
  assert.deepEqual(sleeps, [])
})

test("post-change health failure reports live but unhealthy Production", async () => {
  const vercel = new FakeVercel()
  vercel.productions = [
    production(CURRENT),
    production(CURRENT),
    production(TARGET),
  ]
  vercel.productionHealthError = new SafetyError(
    "HEALTH_CHECK_FAILED",
    "unhealthy"
  )
  const result = await executeTransition(
    "promote",
    {
      targetDeploymentId: TARGET,
      expectedCurrentDeploymentId: CURRENT,
      expectedGitSha: SHA,
    },
    { ...config, healthPaths: ["/healthz"] },
    dependencies(vercel).value
  )

  assert.equal(result.status, "unhealthy")
  assert.equal(result.currentDeploymentId, TARGET)
})
