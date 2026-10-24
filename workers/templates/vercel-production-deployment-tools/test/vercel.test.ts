import assert from "node:assert/strict"
import test from "node:test"
import { loadConfig } from "../src/config.js"
import { SafetyError, VercelHttpError } from "../src/types.js"
import { VercelClient } from "../src/vercel.js"

const TEAM = "team_acme"
const PROJECT = "prj_checkout"
const DEPLOYMENT = "dpl_candidate"
const SHA = "a".repeat(40)

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status })
}

function deployment(overrides: Record<string, unknown> = {}) {
  return {
    id: DEPLOYMENT,
    ownerId: TEAM,
    team: { id: TEAM },
    projectId: PROJECT,
    project: { id: PROJECT },
    url: "checkout-candidate.vercel.app",
    target: "production",
    readyState: "READY",
    readySubstate: "STAGED",
    checksState: "completed",
    checksConclusion: "succeeded",
    gitSource: { sha: SHA },
    ...overrides,
  }
}

function client(
  fetchImpl: typeof fetch,
  options: {
    sleep?: (milliseconds: number) => Promise<void>
    protectionBypassSecret?: string | null
  } = {}
) {
  return new VercelClient({
    token: "vercel-secret",
    protectionBypassSecret: options.protectionBypassSecret ?? null,
    requestTimeoutMs: 1_000,
    healthTimeoutMs: 1_000,
    fetchImpl,
    sleep: options.sleep,
    now: () => new Date("2026-07-04T12:00:00.000Z"),
  })
}

function errorCode(code: string) {
  return (error: unknown) => error instanceof SafetyError && error.code === code
}

test("deployment reads use the v13 contract and normalize provider identity", async () => {
  let calls = 0
  const fetchImpl = (async (
    request: string | URL | Request,
    init?: RequestInit
  ) => {
    calls++
    assert.equal(
      String(request),
      "https://api.vercel.com/v13/deployments/dpl_candidate?withGitRepoInfo=true&teamId=team_acme"
    )
    assert.equal(init?.redirect, "manual")
    assert.deepEqual(init?.headers, {
      Authorization: "Bearer vercel-secret",
      Accept: "application/json",
    })
    return json(deployment())
  }) as typeof fetch

  assert.deepEqual(
    await client(fetchImpl).getDeployment(TEAM, PROJECT, DEPLOYMENT),
    {
      id: DEPLOYMENT,
      projectId: PROJECT,
      teamId: TEAM,
      url: "checkout-candidate.vercel.app",
      target: "production",
      readyState: "READY",
      readySubstate: "STAGED",
      gitSha: SHA,
      checksState: "completed",
      checksConclusion: "succeeded",
    }
  )
  assert.equal(calls, 1)

  const noGit = client((async () =>
    json(deployment({ gitSource: undefined }))) as typeof fetch)
  assert.equal(
    (await noGit.getDeployment(TEAM, PROJECT, DEPLOYMENT)).gitSha,
    null
  )

  const wrongProject = client((async () =>
    json(deployment({ projectId: "prj_other" }))) as typeof fetch)
  await assert.rejects(
    () => wrongProject.getDeployment(TEAM, PROJECT, DEPLOYMENT),
    errorCode("DEPLOYMENT_IDENTITY_MISMATCH")
  )
})

function alias(domain: string, deploymentId: string) {
  return {
    domain,
    environment: "production",
    target: "PRODUCTION",
    deployment: { id: deploymentId },
  }
}

test("production state follows Vercel direct-serving aliases", async () => {
  const body = {
    id: PROJECT,
    accountId: TEAM,
    alias: [
      alias("www.example.com", "dpl_current"),
      alias("app.example.com", "dpl_current"),
      {
        ...alias("redirect.example.com", "dpl_current"),
        redirect: "app.example.com",
      },
      {
        domain: "preview.example.com",
        target: "PREVIEW",
        environment: "preview",
        deployment: { id: DEPLOYMENT },
      },
    ],
  }
  const observation = await client((async () =>
    json(body)) as typeof fetch).observeProduction(TEAM, PROJECT)
  assert.deepEqual(observation, {
    currentDeploymentId: "dpl_current",
    domainDeploymentIds: {
      "www.example.com": "dpl_current",
      "app.example.com": "dpl_current",
    },
    productionDomains: ["app.example.com", "www.example.com"],
  })

  const split = {
    ...body,
    alias: [
      alias("app.example.com", "dpl_current"),
      alias("www.example.com", DEPLOYMENT),
    ],
  }
  assert.equal(
    (
      await client((async () => json(split)) as typeof fetch).observeProduction(
        TEAM,
        PROJECT
      )
    ).currentDeploymentId,
    null
  )

  const manyDomains = Array.from({ length: 11 }, (_, index) =>
    alias(`app-${index}.example.com`, "dpl_current")
  )
  const many = await client((async () =>
    json({ ...body, alias: manyDomains })) as typeof fetch).observeProduction(
    TEAM,
    PROJECT
  )
  assert.equal(many.productionDomains.length, 11)

  const tooManyDomains = Array.from({ length: 101 }, (_, index) =>
    alias(`app-${index}.example.com`, "dpl_current")
  )
  await assert.rejects(
    () =>
      client((async () =>
        json({
          ...body,
          alias: tooManyDomains,
        })) as typeof fetch).observeProduction(TEAM, PROJECT),
    errorCode("PRODUCTION_DOMAINS_UNSUPPORTED")
  )
})

test("rolling-release reads distinguish none, configured, and active", async () => {
  for (const [configuration, active, expected] of [
    [null, null, "none"],
    [{ stages: [10, 100] }, null, "configured"],
    [{ stages: [10, 100] }, { state: "ACTIVE" }, "active"],
  ] as const) {
    const fetchImpl = (async (request: string | URL | Request) =>
      json({
        rollingRelease: String(request).includes("/config?")
          ? configuration
          : active,
      })) as typeof fetch
    assert.equal(
      await client(fetchImpl).getRollingReleaseState(TEAM, PROJECT),
      expected
    )
  }

  await assert.rejects(
    () =>
      client((async () => json({})) as typeof fetch).getRollingReleaseState(
        TEAM,
        PROJECT
      ),
    errorCode("ROLLING_RELEASE_RESPONSE_INVALID")
  )
})

test("traffic mutations use exact versioned endpoints and one bodyless POST", async () => {
  const cases = [
    {
      action: "promote" as const,
      status: 201,
      url: "https://api.vercel.com/v10/projects/prj_checkout/promote/dpl_candidate?teamId=team_acme",
    },
    {
      action: "promote" as const,
      status: 202,
      url: "https://api.vercel.com/v10/projects/prj_checkout/promote/dpl_candidate?teamId=team_acme",
    },
    {
      action: "rollback" as const,
      status: 201,
      url: "https://api.vercel.com/v1/projects/prj_checkout/rollback/dpl_candidate?teamId=team_acme&description=Rollback%20requested%20from%20Notion",
    },
  ]

  for (const item of cases) {
    let calls = 0
    const fetchImpl = (async (
      request: string | URL | Request,
      init?: RequestInit
    ) => {
      calls++
      assert.equal(String(request), item.url)
      assert.equal(init?.method, "POST")
      assert.equal(init?.redirect, "manual")
      assert.equal(init?.body, undefined)
      return new Response(null, { status: item.status })
    }) as typeof fetch
    await client(fetchImpl).requestTransition(
      item.action,
      TEAM,
      PROJECT,
      DEPLOYMENT
    )
    assert.equal(calls, 1)
  }
})

test("mutation failures are classified but never retried", async () => {
  for (const item of [
    { status: 409, ambiguous: false },
    { status: 500, ambiguous: true },
  ]) {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response('{"secret":"do not leak"}', {
        status: item.status,
      })
    }) as typeof fetch
    await assert.rejects(
      () =>
        client(fetchImpl).requestTransition(
          "promote",
          TEAM,
          PROJECT,
          DEPLOYMENT
        ),
      (error: unknown) => {
        assert.ok(error instanceof VercelHttpError)
        assert.equal(error.status, item.status)
        assert.equal(error.ambiguous, item.ambiguous)
        assert.doesNotMatch(error.message, /do not leak|vercel-secret/)
        return true
      }
    )
    assert.equal(calls, 1)
  }

  let calls = 0
  const lost = (async () => {
    calls++
    throw new Error("socket failed with secret")
  }) as typeof fetch
  await assert.rejects(
    () => client(lost).requestTransition("rollback", TEAM, PROJECT, DEPLOYMENT),
    (error: unknown) => error instanceof VercelHttpError && error.ambiguous
  )
  assert.equal(calls, 1)
})

test("idempotent reads retry bounded transient failures", async () => {
  let calls = 0
  const sleeps: number[] = []
  const fetchImpl = (async () => {
    calls++
    return calls < 3 ? new Response(null, { status: 503 }) : json(deployment())
  }) as typeof fetch
  const result = await client(fetchImpl, {
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds)
    },
  }).getDeployment(TEAM, PROJECT, DEPLOYMENT)

  assert.equal(result.id, DEPLOYMENT)
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [250, 250])
})

test("optional health checks do nothing by default and never follow redirects", async () => {
  const observed: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = (async (
    request: string | URL | Request,
    init?: RequestInit
  ) => {
    observed.push({ url: String(request), init })
    return new Response(null, { status: 204 })
  }) as typeof fetch
  const vercel = client(fetchImpl, {
    protectionBypassSecret: "bypass-secret",
  })

  await vercel.checkDeploymentHealth("checkout-candidate.vercel.app", [])
  assert.deepEqual(observed, [])

  await vercel.checkDeploymentHealth("checkout-candidate.vercel.app", [
    "/healthz",
  ])
  await vercel.checkProductionHealth(["app.example.com"], ["/healthz"])
  assert.deepEqual(
    observed.map(({ url }) => url),
    [
      "https://checkout-candidate.vercel.app/healthz",
      "https://app.example.com/healthz",
    ]
  )
  assert.deepEqual(observed[0].init?.headers, {
    "x-vercel-protection-bypass": "bypass-secret",
  })
  assert.equal(observed[1].init?.headers, undefined)
  assert.ok(observed.every(({ init }) => init?.redirect === "manual"))

  await assert.rejects(
    () =>
      vercel.checkProductionHealth(
        Array.from({ length: 11 }, (_, index) => `app-${index}.example.com`),
        ["/healthz"]
      ),
    errorCode("PRODUCTION_DOMAINS_INVALID")
  )
  assert.equal(observed.length, 2)

  const redirecting = client(
    (async () => new Response(null, { status: 302 })) as typeof fetch
  )
  await assert.rejects(
    () =>
      redirecting.checkDeploymentHealth("checkout-candidate.vercel.app", [
        "/healthz",
      ]),
    errorCode("HEALTH_CHECK_FAILED")
  )
})

test("configuration requires only Vercel identity and accepts optional health paths", () => {
  const base = {
    VERCEL_ACCESS_TOKEN: "token",
    VERCEL_TEAM_ID: TEAM,
    VERCEL_PROJECT_ID: PROJECT,
  }
  assert.deepEqual(loadConfig(base), {
    vercelToken: "token",
    teamId: TEAM,
    projectId: PROJECT,
    healthPaths: [],
    protectionBypassSecret: null,
  })
  assert.deepEqual(
    loadConfig({ ...base, VERCEL_HEALTH_PATHS_JSON: '["/healthz"]' })
      .healthPaths,
    ["/healthz"]
  )
  assert.throws(
    () => loadConfig({ ...base, VERCEL_HEALTH_PATHS_JSON: '["//evil"]' }),
    errorCode("CONFIGURATION")
  )
})
