import assert from "node:assert/strict"
import test from "node:test"

import {
  GitHubApiError,
  GitHubClient,
  GitHubPreconditionError,
  GitHubPublishedPostconditionError,
} from "../src/github.js"
import { sha256 } from "../src/policy.js"
import {
  BODY,
  COMMIT,
  makeInput,
  NAME,
  RELEASE_ID,
  REPOSITORY,
  REPOSITORY_ID,
  makeReleaseRecord,
} from "./fixtures.js"

type PatchMode =
  | "success"
  | "409-publish"
  | "timeout-publish"
  | "hanging-body-publish"
  | "success-drift"
  | "success-still-draft"
  | "403"

function json(
  value: unknown,
  status = 200,
  headers: HeadersInit = {}
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}

function hangingJson(signal: AbortSignal | null | undefined): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("{"))
        signal?.addEventListener(
          "abort",
          () => controller.error(signal.reason),
          { once: true }
        )
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  )
}

function harness(
  options: {
    repositoryId?: number
    fullName?: string
    name?: string
    body?: string
    checkAppId?: number
    patchMode?: PatchMode
    latestReleaseId?: number
    repositoryFailures?: number[]
    repositoryFailureHeaders?: HeadersInit
    repositoryFailureMessage?: string
    rateLimitWithoutHeader?: boolean
    throwRepositoryReads?: number
    assetPages?: unknown[][]
    checkPages?: unknown[][]
    initialPublished?: boolean
    targetCommitish?: string
    publishedBody?: string
    hangRepositoryBodies?: boolean
    now?: number
  } = {}
) {
  let published = options.initialPublished ?? false
  let repositoryThrows = options.throwRepositoryReads ?? 0
  const repositoryFailures = [...(options.repositoryFailures ?? [])]
  const requests: { method: string; url: URL; init: RequestInit }[] = []
  const authRepositoryIds: number[] = []
  const assetPages = options.assetPages ?? [
    [
      {
        id: 1,
        name: "app.tar.gz",
        size: 512,
        digest: `sha256:${"b".repeat(64)}`,
      },
    ],
  ]
  const checkPages = options.checkPages ?? [
    [
      {
        id: 2,
        name: "build",
        status: "completed",
        conclusion: "success",
        app: { id: options.checkAppId ?? 15368 },
      },
    ],
  ]

  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? "GET"
    requests.push({ method, url, init })
    const repoPath = `/repos/${REPOSITORY}`

    if (url.pathname === repoPath && method === "GET") {
      if (options.hangRepositoryBodies) return hangingJson(init.signal)
      if (repositoryThrows > 0) {
        repositoryThrows--
        const error = new Error("request aborted")
        error.name = "AbortError"
        throw error
      }
      const failure = repositoryFailures.shift()
      if (failure !== undefined) {
        return json(
          {
            message:
              options.repositoryFailureMessage ??
              "SECRET provider-controlled error body",
          },
          failure,
          options.repositoryFailureHeaders ??
            (failure === 429 && !options.rateLimitWithoutHeader
              ? { "Retry-After": "0" }
              : failure === 403
                ? { "X-RateLimit-Remaining": "1" }
                : {})
        )
      }
      return json({
        id: options.repositoryId ?? REPOSITORY_ID,
        full_name: options.fullName ?? REPOSITORY,
        archived: false,
        disabled: false,
      })
    }

    if (
      url.pathname === `${repoPath}/releases/${RELEASE_ID}` &&
      method === "PATCH"
    ) {
      const mode = options.patchMode ?? "success"
      if (mode === "403") {
        return json({ message: "SECRET token ghp_example" }, 403, {
          "X-GitHub-Request-Id": "safe-request-id",
        })
      }
      published = mode !== "success-still-draft"
      if (mode === "409-publish") return json({ message: "conflict" }, 409)
      if (mode === "timeout-publish") {
        const error = new Error("request aborted")
        error.name = "AbortError"
        throw error
      }
      if (mode === "hanging-body-publish") return hangingJson(init.signal)
      return json(releaseResponse(true))
    }

    if (url.pathname === `${repoPath}/releases/latest`) {
      return json({
        ...releaseResponse(true),
        id: options.latestReleaseId ?? RELEASE_ID,
      })
    }
    if (url.pathname === `${repoPath}/releases/${RELEASE_ID}`) {
      return json(releaseResponse(published))
    }
    if (url.pathname === `${repoPath}/releases/${RELEASE_ID}/assets`) {
      const page = Number(url.searchParams.get("page") ?? "1")
      const values = assetPages[page - 1] ?? []
      const headers: Record<string, string> =
        page < assetPages.length
          ? {
              Link: `<https://api.github.test${url.pathname}?page=${page + 1}>; rel="next"`,
            }
          : {}
      return json(values, 200, headers)
    }
    if (url.pathname === `${repoPath}/git/ref/tags/v1.2.3`) {
      return json({
        ref: "refs/tags/v1.2.3",
        object: { type: "commit", sha: COMMIT },
      })
    }
    if (url.pathname === `${repoPath}/commits/${COMMIT}`) {
      return json({ sha: COMMIT })
    }
    if (url.pathname === `${repoPath}/commits/${COMMIT}/check-runs`) {
      const page = Number(url.searchParams.get("page") ?? "1")
      const values = checkPages[page - 1] ?? []
      const headers: Record<string, string> =
        page < checkPages.length
          ? {
              Link: `<https://api.github.test${url.pathname}?page=${page + 1}>; rel="next"`,
            }
          : {}
      return json(
        { total_count: values.length, check_runs: values },
        200,
        headers
      )
    }
    throw new Error(`unhandled ${method} ${url}`)
  }

  function releaseResponse(isPublished: boolean) {
    return {
      id: RELEASE_ID,
      html_url: `https://github.com/${REPOSITORY}/releases/tag/v1.2.3`,
      tag_name: "v1.2.3",
      target_commitish: options.targetCommitish ?? COMMIT,
      name: options.name ?? NAME,
      body:
        isPublished && options.publishedBody !== undefined
          ? options.publishedBody
          : (options.body ?? BODY),
      draft: !isPublished,
      prerelease: false,
      published_at: isPublished ? "2026-07-03T12:00:00Z" : null,
    }
  }

  const client = new GitHubClient({
    apiBaseUrl: "https://api.github.test",
    fetch,
    sleep: async () => {},
    now: () => options.now ?? Date.now(),
    requestTimeoutMs: 50,
    getAccessToken: async (repositoryId) => {
      authRepositoryIds.push(repositoryId)
      return "test-token"
    },
  })
  return { client, requests, authRepositoryIds, isPublished: () => published }
}

test("verifies exact state, publishes once, and verifies observable latest release", async () => {
  const h = harness()
  const input = makeInput()
  assert.equal(
    (await h.client.verifyPreparedRelease(input, REPOSITORY_ID)).state,
    "draft"
  )
  const result = await h.client.publishAndReconcile(input, REPOSITORY_ID)
  assert.equal(result.release.state, "published")
  assert.equal(result.reconciledAfterAmbiguousResponse, false)
  assert.equal(
    h.requests.filter((request) => request.method === "PATCH").length,
    1
  )
  const patch = h.requests.find((request) => request.method === "PATCH")
  assert.equal(
    patch?.init.body,
    JSON.stringify({ draft: false, make_latest: "true" })
  )
  assert.equal(
    new Headers(patch?.init.headers).get("X-GitHub-Api-Version"),
    "2026-03-10"
  )
  assert.ok(h.authRepositoryIds.every((id) => id === REPOSITORY_ID))
  assert.ok(
    h.requests.some((request) =>
      request.url.pathname.endsWith("/releases/latest")
    )
  )
})

test("numeric repository mismatch stops after the identity read with zero writes", async () => {
  const h = harness({ repositoryId: REPOSITORY_ID + 1 })
  await assert.rejects(
    h.client.verifyPreparedRelease(makeInput(), REPOSITORY_ID),
    GitHubPreconditionError
  )
  assert.equal(h.requests.length, 1)
  assert.equal(
    h.requests.filter((request) => request.method === "PATCH").length,
    0
  )
})

test("changed body and wrong check App identity fail before publication", async () => {
  const changedBody = harness({ body: "injected instructions" })
  await assert.rejects(
    changedBody.client.verifyPreparedRelease(makeInput(), REPOSITORY_ID),
    /body hash/
  )
  assert.equal(
    changedBody.requests.some((request) => request.method === "PATCH"),
    false
  )

  const wrongApp = harness({ checkAppId: 999 })
  await assert.rejects(
    wrongApp.client.verifyPreparedRelease(makeInput(), REPOSITORY_ID),
    /Required check-run/
  )
  assert.equal(
    wrongApp.requests.some((request) => request.method === "PATCH"),
    false
  )
})

for (const patchMode of [
  "409-publish",
  "timeout-publish",
  "hanging-body-publish",
] as const) {
  test(`${patchMode} is reconciled by exact published release ID without a second PATCH`, async () => {
    const h = harness({ patchMode })
    const result = await h.client.publishAndReconcile(
      makeInput(),
      REPOSITORY_ID
    )
    assert.equal(result.release.state, "published")
    assert.equal(result.reconciledAfterAmbiguousResponse, true)
    assert.equal(
      h.requests.filter((request) => request.method === "PATCH").length,
      1
    )
  })
}

test("published checkpoint resume ignores advanced branches, latest changes, and stale gates", async () => {
  const h = harness({
    initialPublished: true,
    targetCommitish: "main",
    latestReleaseId: RELEASE_ID + 1,
    checkAppId: 999,
  })
  const release = await h.client.verifyPreparedRelease(
    makeInput(),
    REPOSITORY_ID,
    {
      verifyGates: false,
      verifyLatest: false,
      expectedPublishedRecord: makeReleaseRecord(),
    }
  )

  assert.equal(release.state, "published")
  assert.equal(
    h.requests.some((request) =>
      request.url.pathname.endsWith("/commits/main")
    ),
    false
  )
  assert.equal(
    h.requests.some((request) =>
      request.url.pathname.endsWith("/releases/latest")
    ),
    false
  )
  assert.equal(
    h.requests.some((request) => request.url.pathname.endsWith("/check-runs")),
    false
  )
})

test("uncheckpointed already-published adoption still enforces App-bound gates", async () => {
  const h = harness({ initialPublished: true, checkAppId: 999 })
  await assert.rejects(
    h.client.verifyPreparedRelease(makeInput(), REPOSITORY_ID),
    (error: unknown) => {
      assert.ok(error instanceof GitHubPublishedPostconditionError)
      assert.match(error.message, /Required check-run/)
      return true
    }
  )
  assert.equal(
    h.requests.some((request) => request.url.pathname.endsWith("/check-runs")),
    true
  )
  assert.equal(
    h.requests.some((request) => request.method === "PATCH"),
    false
  )
})

test("post-PATCH checkpoint drift is reported as published, not as a precondition conflict", async () => {
  const h = harness({
    patchMode: "success-drift",
    publishedBody: "body changed after publication",
  })
  await assert.rejects(
    h.client.publishAndReconcile(makeInput(), REPOSITORY_ID),
    (error: unknown) => {
      assert.ok(error instanceof GitHubPublishedPostconditionError)
      assert.equal(error.record.releaseId, RELEASE_ID)
      assert.equal(error.record.publishedAt, "2026-07-03T12:00:00Z")
      return true
    }
  )
  assert.equal(
    h.requests.filter((request) => request.method === "PATCH").length,
    1
  )
})

test("a later retry still reports an already-published drift as published", async () => {
  const h = harness({
    initialPublished: true,
    publishedBody: "body changed after the earlier publication",
  })
  await assert.rejects(
    h.client.verifyPreparedRelease(makeInput(), REPOSITORY_ID),
    (error: unknown) => {
      assert.ok(error instanceof GitHubPublishedPostconditionError)
      assert.equal(error.record.releaseId, RELEASE_ID)
      return true
    }
  )
  assert.equal(
    h.requests.filter((request) => request.method === "PATCH").length,
    0
  )
})

test("successful PATCH whose exact release still reads draft remains ambiguous", async () => {
  const h = harness({ patchMode: "success-still-draft" })
  await assert.rejects(
    h.client.publishAndReconcile(makeInput(), REPOSITORY_ID),
    (error: unknown) =>
      error instanceof GitHubApiError && error.ambiguousMutation
  )
  assert.equal(h.isPublished(), false)
  assert.equal(
    h.requests.filter((request) => request.method === "PATCH").length,
    1
  )
})

test("403 mutation error is redacted and not retried", async () => {
  const h = harness({ patchMode: "403" })
  await assert.rejects(
    h.client.publishAndReconcile(makeInput(), REPOSITORY_ID),
    (error: unknown) => {
      assert.ok(error instanceof GitHubApiError)
      assert.equal(error.status, 403)
      assert.equal(error.message.includes("SECRET"), false)
      assert.equal(error.message.includes("ghp_"), false)
      return true
    }
  )
  assert.equal(
    h.requests.filter((request) => request.method === "PATCH").length,
    1
  )
})

test("credential failure before PATCH is blocked, not reported as an ambiguous write", async () => {
  let fetchCalls = 0
  const client = new GitHubClient({
    getAccessToken: async () => {
      throw new Error("expired secret credential detail")
    },
    fetch: async () => {
      fetchCalls++
      return json({})
    },
    sleep: async () => {},
  })
  await assert.rejects(
    client.publishAndReconcile(makeInput(), REPOSITORY_ID),
    (error: unknown) =>
      error instanceof GitHubApiError &&
      !error.ambiguousMutation &&
      !error.message.includes("secret")
  )
  assert.equal(fetchCalls, 0)
})

test("safe reads retry bounded 429 and 5xx, but not 404", async () => {
  for (const failure of [429, 500]) {
    const h = harness({ repositoryFailures: [failure] })
    assert.equal(
      (await h.client.verifyPreparedRelease(makeInput(), REPOSITORY_ID)).state,
      "draft"
    )
    assert.equal(
      h.requests.filter(
        (request) => request.url.pathname === `/repos/${REPOSITORY}`
      ).length,
      2
    )
  }

  const missing = harness({ repositoryFailures: [404] })
  await assert.rejects(
    missing.client.verifyPreparedRelease(makeInput(), REPOSITORY_ID),
    (error: unknown) => error instanceof GitHubApiError && error.status === 404
  )
  assert.equal(missing.requests.length, 1)

  const noHeader = harness({
    repositoryFailures: [429],
    rateLimitWithoutHeader: true,
  })
  await assert.rejects(
    noHeader.client.verifyPreparedRelease(makeInput(), REPOSITORY_ID),
    (error: unknown) =>
      error instanceof GitHubApiError &&
      error.retryAfterSeconds === 60 &&
      error.retryable
  )
  assert.equal(noHeader.requests.length, 1)
})

test("primary rate-limit reset and headerless secondary limits return actionable delays", async () => {
  const now = 1_720_000_000_000
  const primary = harness({
    repositoryFailures: [403],
    repositoryFailureHeaders: {
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": String(now / 1_000 + 120),
    },
    now,
  })
  await assert.rejects(
    primary.client.verifyPreparedRelease(makeInput(), REPOSITORY_ID),
    (error: unknown) => {
      assert.ok(error instanceof GitHubApiError)
      assert.equal(error.retryable, true)
      assert.equal(error.retryAfterSeconds, 120)
      assert.match(error.message, /retry after 120 seconds/)
      return true
    }
  )
  assert.equal(primary.requests.length, 1)

  const capped = harness({
    repositoryFailures: [403],
    repositoryFailureHeaders: {
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": String(now / 1_000 + 900_000),
    },
    now,
  })
  await assert.rejects(
    capped.client.verifyPreparedRelease(makeInput(), REPOSITORY_ID),
    (error: unknown) =>
      error instanceof GitHubApiError && error.retryAfterSeconds === 86_400
  )

  const secondary = harness({
    repositoryFailures: [403],
    repositoryFailureHeaders: {},
    repositoryFailureMessage:
      "You have exceeded a secondary rate limit. Please wait.",
    now,
  })
  await assert.rejects(
    secondary.client.verifyPreparedRelease(makeInput(), REPOSITORY_ID),
    (error: unknown) => {
      assert.ok(error instanceof GitHubApiError)
      assert.equal(error.retryable, true)
      assert.equal(error.retryAfterSeconds, 60)
      assert.match(error.message, /retry after 60 seconds/)
      assert.equal(error.message.includes("Please wait"), false)
      return true
    }
  )
  assert.equal(secondary.requests.length, 1)
})

test("read timeout exhausts before mutation and remains retryable", async () => {
  const h = harness({ throwRepositoryReads: 2 })
  await assert.rejects(
    h.client.verifyPreparedRelease(makeInput(), REPOSITORY_ID),
    (error: unknown) => error instanceof GitHubApiError && error.retryable
  )
  assert.equal(
    h.requests.filter((request) => request.method === "PATCH").length,
    0
  )
})

test("safe-read timeout covers a response body that never finishes", async () => {
  const h = harness({ hangRepositoryBodies: true })
  await assert.rejects(
    h.client.verifyPreparedRelease(makeInput(), REPOSITORY_ID),
    (error: unknown) => error instanceof GitHubApiError && error.retryable
  )
  assert.equal(
    h.requests.filter(
      (request) => request.url.pathname === `/repos/${REPOSITORY}`
    ).length,
    2
  )
  assert.equal(
    h.requests.filter((request) => request.method === "PATCH").length,
    0
  )
})

test("latest-release mismatch prevents a false completed claim", async () => {
  const h = harness({
    patchMode: "409-publish",
    latestReleaseId: RELEASE_ID + 1,
  })
  await assert.rejects(
    h.client.publishAndReconcile(makeInput(), REPOSITORY_ID),
    /observable latest release/
  )
})

test("asset and check pagination are bounded", async () => {
  const dummyChecks = Array.from({ length: 100 }, (_, index) => ({
    id: index,
    name: `dummy-${index}`,
    status: "completed",
    conclusion: "success",
    app: { id: 15368 },
  }))
  const desired = {
    id: 101,
    name: "build",
    status: "completed",
    conclusion: "success",
    app: { id: 15368 },
  }
  const pagedChecks = harness({ checkPages: [dummyChecks, [desired]] })
  assert.equal(
    (await pagedChecks.client.verifyPreparedRelease(makeInput(), REPOSITORY_ID))
      .state,
    "draft"
  )

  const hundredAssets = Array.from({ length: 100 }, (_, index) => ({
    id: index,
    name: index === 0 ? "app.tar.gz" : `asset-${index}.zip`,
    size: index === 0 ? 512 : index,
    digest: `sha256:${index === 0 ? "b".repeat(64) : sha256(String(index))}`,
  }))
  const tooManyAssets = harness({
    assetPages: [
      hundredAssets,
      [
        {
          id: 101,
          name: "overflow.zip",
          size: 1,
          digest: `sha256:${"c".repeat(64)}`,
        },
      ],
    ],
  })
  await assert.rejects(
    tooManyAssets.client.verifyPreparedRelease(makeInput(), REPOSITORY_ID),
    /more than the supported 100/
  )
})
