import assert from "node:assert/strict"
import { test } from "node:test"
import { SafetyError, VercelHttpError } from "../src/types.js"
import {
  MAX_CHECK_DEFINITIONS,
  MAX_CHECK_RUNS,
  MAX_PROJECT_ALIAS_INVENTORY,
  MAX_PRODUCTION_HEALTH_DOMAINS,
  MAX_VERCEL_RESPONSE_BYTES,
  VercelClient,
} from "../src/vercel.js"

const SHA = "a".repeat(40)
const TEAM = "team_acme"
const PROJECT = "prj_checkout"
const DEPLOYMENT = "dpl_candidate"

function client(fetchImpl: typeof fetch, sleep = async (_ms: number) => {}) {
  return new VercelClient({
    token: "vercel-secret-token",
    protectionBypassSecret: null,
    requestTimeoutMs: 1_000,
    healthTimeoutMs: 1_000,
    fetchImpl,
    sleep,
    now: () => new Date("2026-07-03T14:00:00.000Z"),
  })
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status })
}

function deployment(overrides: Record<string, unknown> = {}) {
  return {
    id: "dpl_candidate",
    ownerId: "team_acme",
    team: {
      id: "team_acme",
      name: "Acme",
      slug: "acme",
    },
    projectId: "prj_checkout",
    url: "checkout-git-abc.vercel.app",
    target: "production",
    readyState: "READY",
    readySubstate: "STAGED",
    checksState: "completed",
    checksConclusion: "succeeded",
    gitSource: { sha: SHA },
    ...overrides,
  }
}

function errorCode(code: string) {
  return (error: unknown) => error instanceof SafetyError && error.code === code
}

function transition(fetchImpl: typeof fetch, action: "promote" | "rollback") {
  return client(fetchImpl).requestTransition(action, TEAM, PROJECT, DEPLOYMENT)
}

function verify(raw: unknown, expectedGitSha = SHA) {
  return client((async () => json(raw)) as typeof fetch).verifyDeployment(
    TEAM,
    PROJECT,
    DEPLOYMENT,
    expectedGitSha,
    "staged"
  )
}

function observe(body: unknown, domains = ["checkout.example.com"]) {
  return client((async () => json(body)) as typeof fetch).observeProduction(
    TEAM,
    PROJECT,
    domains
  )
}

test("transition POSTs use exact endpoints, manual redirects, no body, and one attempt", async () => {
  const cases = [
    [
      "promote",
      202,
      "https://api.vercel.com/v10/projects/prj_checkout/promote/dpl_candidate?teamId=team_acme",
    ],
    [
      "rollback",
      201,
      "https://api.vercel.com/v1/projects/prj_checkout/rollback/dpl_candidate?teamId=team_acme&description=Notion-approved%20rollback%20to%20dpl_candidate",
    ],
  ] as const
  for (const [action, status, url] of cases) {
    let calls = 0
    const fetchImpl = (async (
      request: string | URL | Request,
      init?: RequestInit
    ) => {
      calls++
      assert.equal(String(request), url)
      assert.equal(init?.method, "POST")
      assert.equal(init?.redirect, "manual")
      assert.equal(init?.body, undefined)
      assert.deepEqual(init?.headers, {
        Authorization: "Bearer vercel-secret-token",
        Accept: "application/json",
      })
      return new Response(null, { status })
    }) as typeof fetch
    await transition(fetchImpl, action)
    assert.equal(calls, 1)
  }
})

test("transition errors use a closed definite set and never retry", async () => {
  const definite = {
    promote: [400, 401, 403, 409, 429],
    rollback: [400, 401, 402, 403, 409, 422, 429],
  }
  for (const action of ["promote", "rollback"] as const) {
    for (const status of [
      200, 302, 400, 401, 402, 403, 404, 408, 409, 422, 429, 500,
    ]) {
      let calls = 0
      const fetchImpl = (async () => {
        calls++
        return new Response('{"error":"provider-secret"}', {
          status,
          headers: status === 429 ? { "retry-after": "12" } : undefined,
        })
      }) as typeof fetch
      await assert.rejects(
        () => transition(fetchImpl, action),
        (error: unknown) => {
          assert.ok(error instanceof VercelHttpError)
          assert.equal(error.status, status)
          assert.equal(error.ambiguous, !definite[action].includes(status))
          assert.doesNotMatch(error.message, /provider-secret|vercel-secret/)
          return true
        }
      )
      assert.equal(calls, 1)
    }
  }
})

test("transport loss is ambiguous and is not retried", async () => {
  let calls = 0
  const fetchImpl = (async () => {
    calls++
    throw new Error("socket reset with provider-secret")
  }) as typeof fetch
  await assert.rejects(
    () => transition(fetchImpl, "promote"),
    (error: unknown) => {
      assert.ok(error instanceof VercelHttpError)
      assert.equal(error.status, null)
      assert.equal(error.ambiguous, true)
      assert.doesNotMatch(error.message, /provider-secret/)
      return true
    }
  )
  assert.equal(calls, 1)
})

test("rolling-release guard reads configuration and ACTIVE state and fails closed", async () => {
  const urls: string[] = []
  const goodFetch = (async (request: string | URL | Request) => {
    urls.push(String(request))
    return json({ rollingRelease: null, requestId: "iad1::request" })
  }) as typeof fetch
  await client(goodFetch).assertRollingReleasesDisabled(TEAM, PROJECT)
  assert.deepEqual(urls.sort(), [
    "https://api.vercel.com/v1/projects/prj_checkout/rolling-release/config?teamId=team_acme",
    "https://api.vercel.com/v1/projects/prj_checkout/rolling-release?teamId=team_acme&state=ACTIVE",
  ])

  const cases = [
    [
      { rollingRelease: { target: "production" } },
      { rollingRelease: null },
      "ROLLING_RELEASE_CONFIGURED",
    ],
    [
      { rollingRelease: null },
      { rollingRelease: { state: "ACTIVE" } },
      "ROLLING_RELEASE_ACTIVE",
    ],
    [
      { requestId: "iad1::request" },
      { rollingRelease: null },
      "ROLLING_RELEASE_RESPONSE_INVALID",
    ],
  ] as const
  for (const [config, active, code] of cases) {
    const fetchImpl = (async (request: string | URL | Request) =>
      json(
        String(request).includes("/config?") ? config : active
      )) as typeof fetch
    await assert.rejects(
      () => client(fetchImpl).assertRollingReleasesDisabled(TEAM, PROJECT),
      errorCode(code)
    )
  }
})

test("idempotent reads retry at most three times and dispose failed bodies", async () => {
  let calls = 0
  let cancellations = 0
  const sleeps: number[] = []
  const fetchImpl = (async () => {
    calls++
    if (calls < 3) {
      return new Response(
        new ReadableStream({
          cancel() {
            cancellations++
          },
        }),
        { status: 503 }
      )
    }
    return json(deployment())
  }) as typeof fetch
  const result = await client(fetchImpl, async (milliseconds) => {
    sleeps.push(milliseconds)
  }).verifyDeployment(TEAM, PROJECT, DEPLOYMENT, SHA, "staged")
  assert.equal(result.id, DEPLOYMENT)
  assert.equal(calls, 3)
  assert.equal(cancellations, 2)
  assert.deepEqual(sleeps, [250, 250])
})

test("a long Retry-After is surfaced instead of retried early", async () => {
  let calls = 0
  const sleeps: number[] = []
  const fetchImpl = (async () => {
    calls++
    return new Response(null, {
      status: 429,
      headers: { "retry-after": "12" },
    })
  }) as typeof fetch
  await assert.rejects(
    () =>
      client(fetchImpl, async (milliseconds) => {
        sleeps.push(milliseconds)
      }).verifyDeployment(TEAM, PROJECT, DEPLOYMENT, SHA, "staged"),
    (error: unknown) => {
      assert.ok(error instanceof VercelHttpError)
      assert.equal(error.status, 429)
      assert.equal(error.retryAfterMs, 12_000)
      return true
    }
  )
  assert.equal(calls, 1)
  assert.deepEqual(sleeps, [])
})

test("successful JSON bodies are capped at one MiB", async () => {
  let canceled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_VERCEL_RESPONSE_BYTES))
      controller.enqueue(new Uint8Array(1))
    },
    cancel() {
      canceled = true
    },
  })
  const fetchImpl = (async () =>
    new Response(body, { status: 200 })) as typeof fetch
  await assert.rejects(
    () =>
      client(fetchImpl).verifyDeployment(
        TEAM,
        PROJECT,
        DEPLOYMENT,
        SHA,
        "staged"
      ),
    (error: unknown) =>
      error instanceof VercelHttpError &&
      error.message.includes(`${MAX_VERCEL_RESPONSE_BYTES}-byte limit`)
  )
  assert.equal(canceled, true)
})

function checksFetch(
  definitions: unknown[],
  runs: unknown[],
  raw = deployment()
): typeof fetch {
  return (async (request: string | URL | Request) => {
    const url = String(request)
    if (url.includes("/checks?")) return json({ checks: definitions })
    if (url.includes("/check-runs?")) return json({ runs })
    return json(raw)
  }) as typeof fetch
}

function checkDefinition(overrides: Record<string, unknown> = {}) {
  return {
    id: "check_build",
    name: "Build",
    ownerId: TEAM,
    projectId: PROJECT,
    isRerequestable: true,
    requires: "build-ready",
    source: {
      kind: "integration",
      integrationId: "oac_example",
      integrationConfigurationId: "icfg_example",
    },
    blocks: "deployment-promotion",
    targets: ["production"],
    sourceKind: "integration",
    timeout: 300,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function checkRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "checkrun_build",
    name: "Build",
    ownerId: TEAM,
    deploymentId: DEPLOYMENT,
    checkId: "check_build",
    status: "completed",
    conclusion: "succeeded",
    timeout: 300,
    createdAt: 1,
    updatedAt: 2,
    completedAt: 2,
    source: {
      kind: "integration",
      integrationId: "oac_example",
      integrationConfigurationId: "icfg_example",
    },
    ...overrides,
  }
}

test("check inventories are capped at 100 items", async () => {
  const cases = [
    {
      definitions: Array.from(
        { length: MAX_CHECK_DEFINITIONS + 1 },
        () => ({})
      ),
      runs: [],
      message: /more than 100 checks/,
    },
    {
      definitions: [],
      runs: Array.from({ length: MAX_CHECK_RUNS + 1 }, () => ({})),
      message: /more than 100 runs/,
    },
  ]
  for (const item of cases) {
    await assert.rejects(
      () =>
        client(checksFetch(item.definitions, item.runs)).verifyDeploymentChecks(
          TEAM,
          PROJECT,
          DEPLOYMENT,
          ["check_build"]
        ),
      item.message
    )
  }
})

test("the latest contract-valid run determines each required check", async () => {
  const definition = checkDefinition()
  await client(
    checksFetch(
      [definition],
      [
        checkRun({ createdAt: 1, updatedAt: 10, completedAt: 10 }),
        checkRun({ createdAt: 2, updatedAt: 3, completedAt: 3 }),
      ]
    )
  ).verifyDeploymentChecks(TEAM, PROJECT, DEPLOYMENT, ["check_build"])
  await assert.rejects(
    () =>
      client(
        checksFetch(
          [definition],
          [
            checkRun({ createdAt: 1, updatedAt: 10, completedAt: 10 }),
            checkRun({
              createdAt: 2,
              updatedAt: 3,
              completedAt: 3,
              conclusion: "failed",
            }),
          ]
        )
      ).verifyDeploymentChecks(TEAM, PROJECT, DEPLOYMENT, ["check_build"]),
    errorCode("DEPLOYMENT_CHECK_FAILED")
  )
})

test("check runs may omit projectId but must match the configured owner", async () => {
  await client(
    checksFetch([checkDefinition()], [checkRun()])
  ).verifyDeploymentChecks(TEAM, PROJECT, DEPLOYMENT, ["check_build"])

  await assert.rejects(
    () =>
      client(
        checksFetch([checkDefinition()], [checkRun({ ownerId: "team_other" })])
      ).verifyDeploymentChecks(TEAM, PROJECT, DEPLOYMENT, ["check_build"]),
    errorCode("DEPLOYMENT_CHECK_FAILED")
  )
})

test("a newer pending or updated check run cannot reuse an older success", async () => {
  const definition = checkDefinition()
  const oldSuccess = checkRun({
    createdAt: 1,
    updatedAt: 100,
    completedAt: 100,
  })
  const newerPending = checkRun({
    createdAt: 2,
    updatedAt: 2,
    status: "running",
    conclusion: undefined,
    completedAt: undefined,
  })
  await assert.rejects(
    () =>
      client(
        checksFetch([definition], [oldSuccess, newerPending])
      ).verifyDeploymentChecks(TEAM, PROJECT, DEPLOYMENT, ["check_build"]),
    errorCode("DEPLOYMENT_CHECK_FAILED")
  )

  const sameCreatedAtFailure = checkRun({
    createdAt: 1,
    updatedAt: 101,
    completedAt: 101,
    conclusion: "failed",
  })
  await assert.rejects(
    () =>
      client(
        checksFetch([definition], [oldSuccess, sameCreatedAtFailure])
      ).verifyDeploymentChecks(TEAM, PROJECT, DEPLOYMENT, ["check_build"]),
    errorCode("DEPLOYMENT_CHECK_FAILED")
  )
})

test("deployment reads normalize identity and validate state and Git SHA", async () => {
  assert.deepEqual(await verify(deployment()), {
    id: "dpl_candidate",
    teamId: "team_acme",
    projectId: "prj_checkout",
    url: "checkout-git-abc.vercel.app",
    readyState: "READY",
    gitSha: SHA,
  })
  assert.equal(
    (await verify(deployment({ team: undefined }))).teamId,
    "team_acme"
  )
  const cases: Array<[unknown, string]> = [
    [deployment({ ownerId: undefined }), "DEPLOYMENT_IDENTITY_MISMATCH"],
    [deployment({ ownerId: "team_other" }), "DEPLOYMENT_IDENTITY_MISMATCH"],
    [
      deployment({ team: { id: "team_other", name: "Other", slug: "other" } }),
      "DEPLOYMENT_IDENTITY_MISMATCH",
    ],
    [deployment({ projectId: undefined }), "DEPLOYMENT_IDENTITY_MISMATCH"],
    [deployment({ projectId: "prj_other" }), "DEPLOYMENT_IDENTITY_MISMATCH"],
    [
      deployment({ project: { id: "prj_other" } }),
      "DEPLOYMENT_IDENTITY_MISMATCH",
    ],
    [deployment({ url: "internal.example.com" }), "DEPLOYMENT_URL_UNSAFE"],
    [deployment({ gitSource: { sha: "bad" } }), "GIT_IDENTITY_MISMATCH"],
    [deployment({ readySubstate: "PROMOTED" }), "DEPLOYMENT_STATE_MISMATCH"],
  ]
  for (const [raw, code] of cases) {
    await assert.rejects(() => verify(raw), errorCode(code))
  }
  await assert.rejects(
    () => verify(deployment(), "b".repeat(40)),
    errorCode("GIT_IDENTITY_MISMATCH")
  )
})

function project(aliases: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    id: "prj_checkout",
    accountId: "team_acme",
    alias: aliases,
    ...overrides,
  }
}

function alias(domain: string, deploymentId: string) {
  return {
    domain,
    environment: "production",
    target: "PRODUCTION",
    deployment: { id: deploymentId },
  }
}

test("production observation requires the exact configured alias set and reports split state", async () => {
  const domains = ["checkout.example.com", "www.example.com"]
  const unified = client((async () =>
    json(
      project(domains.map((domain) => alias(domain, "dpl_candidate")))
    )) as typeof fetch)
  assert.deepEqual(await unified.observeProduction(TEAM, PROJECT, domains), {
    currentDeploymentId: "dpl_candidate",
    domainDeploymentIds: {
      "checkout.example.com": "dpl_candidate",
      "www.example.com": "dpl_candidate",
    },
    exactDomainSet: true,
  })
  const split = client((async () =>
    json(
      project([
        alias(domains[0], "dpl_candidate"),
        alias(domains[1], "dpl_previous"),
      ])
    )) as typeof fetch)
  const observation = await split.observeProduction(TEAM, PROJECT, domains)
  assert.equal(observation.currentDeploymentId, null)
})

test("production observation fails closed on identity, alias drift, and inventory bounds", async () => {
  const good = [alias("checkout.example.com", "dpl_candidate")]
  const cases: Array<[unknown, string]> = [
    [project(good, { accountId: "team_other" }), "PROJECT_IDENTITY_MISMATCH"],
    [project(good, { id: "prj_other" }), "PROJECT_IDENTITY_MISMATCH"],
    [
      project([...good, alias("extra.example.com", DEPLOYMENT)]),
      "PROJECT_ALIAS_SET_MISMATCH",
    ],
    [project([...good, ...good]), "PROJECT_ALIAS_SET_MISMATCH"],
    [
      project([
        {
          domain: "checkout.example.com",
          environment: "production",
          target: "PRODUCTION",
          deployment: null,
          redirect: "www.example.com",
        },
      ]),
      "PROJECT_ALIAS_SET_MALFORMED",
    ],
    [
      project(
        Array.from({ length: MAX_PROJECT_ALIAS_INVENTORY + 1 }, (_, i) => ({
          domain: `preview-${i}.example.com`,
        }))
      ),
      "PROJECT_ALIAS_INVENTORY_TOO_LARGE",
    ],
  ]
  for (const [body, code] of cases) {
    await assert.rejects(() => observe(body), errorCode(code))
  }
})

test("health checks cover the deployment and every production domain without redirects", async () => {
  const observed: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = (async (
    request: string | URL | Request,
    init?: RequestInit
  ) => {
    observed.push({ url: String(request), init })
    return new Response(null, { status: 204 })
  }) as typeof fetch
  const vercel = new VercelClient({
    token: "vercel-secret-token",
    protectionBypassSecret: "bypass-secret",
    fetchImpl,
  })
  await vercel.checkDeploymentHealth("checkout-git-abc.vercel.app", [
    "/healthz",
  ])
  await vercel.checkProductionHealth(
    ["checkout.example.com", "www.example.com"],
    ["/healthz", "/ready"]
  )
  assert.deepEqual(
    observed.map(({ url }) => url),
    [
      "https://checkout-git-abc.vercel.app/healthz",
      "https://checkout.example.com/healthz",
      "https://checkout.example.com/ready",
      "https://www.example.com/healthz",
      "https://www.example.com/ready",
    ]
  )
  for (const { init } of observed) {
    assert.equal(init?.redirect, "manual")
  }
  assert.deepEqual(observed[0].init?.headers, {
    "x-vercel-protection-bypass": "bypass-secret",
  })
  for (const { init } of observed.slice(1))
    assert.equal(init?.headers, undefined)
})

test("health checks reject redirects, unsafe hosts, malformed paths, and unbounded domains", async () => {
  let calls = 0
  const fetchImpl = (async () => {
    calls++
    return new Response(null, { status: 302 })
  }) as typeof fetch
  const vercel = client(fetchImpl)
  await assert.rejects(
    () => vercel.checkDeploymentHealth("internal.example.com", ["/healthz"]),
    errorCode("DEPLOYMENT_URL_UNSAFE")
  )
  await assert.rejects(
    () => vercel.checkProductionHealth(["Checkout.example.com"], ["/healthz"]),
    errorCode("PRODUCTION_DOMAINS_INVALID")
  )
  await assert.rejects(
    () =>
      vercel.checkProductionHealth(
        ["checkout.example.com"],
        ["//evil.example/healthz"]
      ),
    errorCode("HEALTH_PATHS_INVALID")
  )
  await assert.rejects(
    () =>
      vercel.checkProductionHealth(
        Array.from(
          { length: MAX_PRODUCTION_HEALTH_DOMAINS + 1 },
          (_, i) => `host-${i}.example.com`
        ),
        ["/healthz"]
      ),
    errorCode("PRODUCTION_DOMAINS_INVALID")
  )
  assert.equal(calls, 0)
  await assert.rejects(
    () => vercel.checkDeploymentHealth("checkout.vercel.app", ["/healthz"]),
    errorCode("HEALTH_CHECK_FAILED")
  )
  assert.equal(calls, 1)
})
