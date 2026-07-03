import assert from "node:assert/strict"
import { test } from "node:test"
import {
  isDefinitePromotionRejectionStatus,
  VercelHttpError,
} from "../src/types.js"
import { VercelClient } from "../src/vercel.js"

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

test("promotion uses the exact v10 endpoint and never sends a body", async () => {
  let calls = 0
  const fetchImpl = (async (
    request: string | URL | Request,
    init?: RequestInit
  ) => {
    calls++
    assert.equal(
      String(request),
      "https://api.vercel.com/v10/projects/prj_checkout/promote/dpl_candidate?teamId=team_acme"
    )
    assert.equal(init?.method, "POST")
    assert.equal(init?.body, undefined)
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      "Bearer vercel-secret-token"
    )
    return new Response(null, { status: 202 })
  }) as typeof fetch
  const result = await client(fetchImpl).requestPromotion(
    "team_acme",
    "prj_checkout",
    "dpl_candidate"
  )
  assert.deepEqual(result, { status: 202 })
  assert.equal(calls, 1)
})

test("promotion never retries 401, 403, 429, or 5xx", async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(null, {
        status,
        headers: status === 429 ? { "retry-after": "12" } : undefined,
      })
    }) as typeof fetch
    await assert.rejects(
      () =>
        client(fetchImpl).requestPromotion(
          "team_acme",
          "prj_checkout",
          "dpl_candidate"
        ),
      (error: unknown) => {
        assert.ok(error instanceof VercelHttpError)
        assert.equal(error.status, status)
        assert.equal(error.ambiguous, status >= 500)
        assert.equal(error.retryAfterMs, status === 429 ? 12_000 : 250)
        assert.doesNotMatch(error.message, /vercel-secret-token/)
        return true
      }
    )
    assert.equal(calls, 1)
  }
})

test("only the closed documented rejection statuses are non-ambiguous", async () => {
  for (const status of [200, 302, 400, 401, 403, 404, 408, 409, 429, 500]) {
    const fetchImpl = (async () =>
      new Response(null, { status })) as typeof fetch
    await assert.rejects(
      () =>
        client(fetchImpl).requestPromotion(
          "team_acme",
          "prj_checkout",
          "dpl_candidate"
        ),
      (error: unknown) => {
        assert.ok(error instanceof VercelHttpError)
        assert.equal(
          error.ambiguous,
          !isDefinitePromotionRejectionStatus(status)
        )
        return true
      }
    )
  }
})

test("transport loss is ambiguous and has no hidden retry", async () => {
  let calls = 0
  const fetchImpl = (async () => {
    calls++
    throw new Error("socket reset")
  }) as typeof fetch
  await assert.rejects(
    () =>
      client(fetchImpl).requestPromotion(
        "team_acme",
        "prj_checkout",
        "dpl_candidate"
      ),
    (error: unknown) => {
      assert.ok(error instanceof VercelHttpError)
      assert.equal(error.status, null)
      assert.equal(error.ambiguous, true)
      return true
    }
  )
  assert.equal(calls, 1)
})

test("idempotent reads retry within a fixed bound", async () => {
  let calls = 0
  const sleeps: number[] = []
  const fetchImpl = (async () => {
    calls++
    if (calls < 3) return new Response(null, { status: 500 })
    return new Response(
      JSON.stringify({ id: "prj_checkout", accountId: "team_acme", alias: [] }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  }) as typeof fetch
  const result = await client(fetchImpl, async (ms) => {
    sleeps.push(ms)
  }).getProject("team_acme", "prj_checkout")
  assert.equal(result.id, "prj_checkout")
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [250, 250])
})

test("provider 404 reads are not retried and authorization stays in headers", async () => {
  let calls = 0
  const fetchImpl = (async (
    request: string | URL | Request,
    init?: RequestInit
  ) => {
    calls++
    assert.equal(
      String(request),
      "https://api.vercel.com/v13/deployments/dpl_missing?withGitRepoInfo=true&teamId=team_acme"
    )
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      "Bearer vercel-secret-token"
    )
    return new Response('{"error":"provider-secret-detail"}', { status: 404 })
  }) as typeof fetch
  await assert.rejects(
    () => client(fetchImpl).getDeployment("team_acme", "dpl_missing"),
    (error: unknown) => {
      assert.ok(error instanceof VercelHttpError)
      assert.equal(error.status, 404)
      assert.doesNotMatch(
        error.message,
        /provider-secret-detail|vercel-secret-token/
      )
      return true
    }
  )
  assert.equal(calls, 1)
})

test("health checks reject arbitrary hosts before fetch", async () => {
  let calls = 0
  const fetchImpl = (async () => {
    calls++
    return new Response(null, { status: 200 })
  }) as typeof fetch
  await assert.rejects(
    () => client(fetchImpl).checkHealth("internal.example.com", ["/healthz"]),
    /outside the fixed/
  )
  assert.equal(calls, 0)
})

test("health redirects are not followed or accepted", async () => {
  let redirect: RequestRedirect | undefined
  const fetchImpl = (async (
    _request: string | URL | Request,
    init?: RequestInit
  ) => {
    redirect = init?.redirect
    return new Response(null, {
      status: 302,
      headers: { location: "https://evil.example" },
    })
  }) as typeof fetch
  await assert.rejects(
    () => client(fetchImpl).checkHealth("checkout.vercel.app", ["/healthz"]),
    /HTTP 302/
  )
  assert.equal(redirect, "manual")
})

test("protection bypass is sent only as the fixed health-check header", async () => {
  let observedUrl = ""
  let observedHeaders: HeadersInit | undefined
  const fetchImpl = (async (
    request: string | URL | Request,
    init?: RequestInit
  ) => {
    observedUrl = String(request)
    observedHeaders = init?.headers
    return new Response(null, { status: 204 })
  }) as typeof fetch
  const protectedClient = new VercelClient({
    token: "vercel-secret-token",
    protectionBypassSecret: "bypass-secret",
    requestTimeoutMs: 1_000,
    healthTimeoutMs: 1_000,
    fetchImpl,
  })
  await protectedClient.checkHealth("checkout.vercel.app", ["/healthz"])
  assert.equal(observedUrl, "https://checkout.vercel.app/healthz")
  assert.deepEqual(observedHeaders, {
    "x-vercel-protection-bypass": "bypass-secret",
  })
})
