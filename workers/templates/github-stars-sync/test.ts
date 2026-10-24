import assert from "node:assert/strict"
import test from "node:test"

import {
  RateLimitError,
  type UserManagedOAuthConfiguration,
} from "@notionhq/workers"

import worker from "./src/index.js"
import {
  createGitHubAccessTokenProvider,
  GITHUB_OAUTH_CAPABILITY_KEY,
  getExpectedGitHubUserId,
  getGitHubAuthMode,
} from "./src/auth.js"
import {
  createGitHubStarsClient,
  GITHUB_API_VERSION,
  GITHUB_PAGE_SIZE,
  GITHUB_REQUEST_TIMEOUT_MS,
  GITHUB_STAR_MEDIA_TYPE,
  MAX_GITHUB_RESPONSE_BYTES,
  MAX_STAR_PAGES,
  nextPageFromLink,
  parseStarredRepositories,
  type FetchImplementation,
  type GitHubStarredRepository,
  type GitHubStarsClient,
} from "./src/github.js"
import {
  PRIMARY_KEY,
  repositorySchema,
  repositoryToChange,
} from "./src/repositories.js"
import {
  createReadyState,
  MAX_SAFE_STARS_SYNC_STATE_BYTES,
  MAX_TRACKED_REPOSITORIES,
  pageFromState,
  runStarsSyncPage,
  STARS_SYNC_STATE_VERSION,
  starsSyncStateSize,
  type StarsSyncState,
} from "./src/sync.js"

const firstPagePayload: unknown = [
  {
    starred_at: "2024-01-15T09:30:00Z",
    repo: {
      id: 1296269,
      name: "Hello-World",
      full_name: "octocat/Hello-World",
      owner: {
        login: "octocat",
      },
      private: false,
      html_url: "https://github.com/octocat/Hello-World",
      description: "A small repository used in GitHub API examples.",
      fork: false,
      homepage: "https://github.com",
      language: "TypeScript",
      forks_count: 9,
      stargazers_count: 80,
      open_issues_count: 2,
      default_branch: "main",
      topics: ["api", "example", "api"],
      archived: false,
      disabled: false,
      visibility: "public",
      pushed_at: "2024-07-01T08:00:00Z",
      created_at: "2011-01-26T19:01:12Z",
      updated_at: "2024-07-01T08:10:00Z",
      license: {
        name: "MIT License",
        spdx_id: "MIT",
      },
    },
  },
  {
    starred_at: "2024-03-02T18:45:00Z",
    repo: {
      id: 987654321,
      name: "internal-toolkit",
      full_name: "acme/internal-toolkit",
      owner: {
        login: "acme",
      },
      private: true,
      html_url: "https://github.com/acme/internal-toolkit",
      description: null,
      fork: true,
      homepage: "not a valid URL",
      language: null,
      forks_count: 1,
      stargazers_count: 4,
      open_issues_count: 0,
      default_branch: "trunk",
      archived: true,
      disabled: false,
      visibility: "private",
      pushed_at: null,
      created_at: null,
      updated_at: null,
      license: null,
    },
  },
]

const secondPagePayload: unknown = [
  {
    starred_at: "2025-06-11T16:20:00Z",
    repo: {
      id: 555000111,
      name: "edge-runtime",
      full_name: "example/edge-runtime",
      owner: {
        login: "example",
      },
      private: false,
      html_url: "https://github.com/example/edge-runtime",
      description: "Experiments for a compact JavaScript runtime.",
      fork: false,
      homepage: "",
      language: "Rust",
      forks_count: 31,
      stargazers_count: 820,
      open_issues_count: 14,
      default_branch: "main",
      topics: ["edge", "runtime", "rust"],
      archived: false,
      disabled: false,
      visibility: "public",
      pushed_at: "2025-06-15T14:00:00Z",
      created_at: "2024-08-20T10:00:00Z",
      updated_at: "2025-06-15T14:05:00Z",
      license: {
        name: "Other",
        spdx_id: "NOASSERTION",
      },
    },
  },
]

function queuedFetch(
  responses: Response[],
  calls: Array<{ input: string | URL | Request; init?: RequestInit }> = []
): FetchImplementation {
  return (async (input, init) => {
    calls.push({ input, init })
    const response = responses.shift()
    assert.ok(response, "mock GitHub response queue was exhausted")
    return response
  }) as FetchImplementation
}

async function captureError(
  action: () => unknown | Promise<unknown>
): Promise<unknown> {
  try {
    await action()
  } catch (error) {
    return error
  }
  assert.fail("expected action to throw")
}

function propertyIncludes(value: unknown, expected: string): boolean {
  return JSON.stringify(value).includes(expected)
}

function isEmptyProperty(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0
}

const firstPage = parseStarredRepositories(firstPagePayload)
const secondPage = parseStarredRepositories(secondPagePayload)
const EXPECTED_USER_ID = "583231"

function authenticatedUserResponse(userId = EXPECTED_USER_ID): Response {
  return Response.json({ id: Number(userId), login: "example-user" })
}

function starWithId(id: number): GitHubStarredRepository {
  const star = structuredClone(firstPage[0])
  star.repo.id = id
  star.repo.name = `repository-${id}`
  star.repo.full_name = `example/repository-${id}`
  star.repo.html_url = `https://github.com/example/repository-${id}`
  star.starred_at = new Date(1_700_000_000_000 + id * 1_000).toISOString()
  return star
}

test("star media-type payloads parse into typed repository records", () => {
  assert.equal(firstPage.length, 2)
  assert.equal(firstPage[0].starred_at, "2024-01-15T09:30:00Z")
  assert.equal(firstPage[0].repo.id, 1296269)
  assert.equal(firstPage[0].repo.full_name, "octocat/Hello-World")
  assert.equal(firstPage[1].repo.visibility, "private")
  assert.deepEqual(firstPage[1].repo.topics, [])
  assert.equal(firstPage[1].repo.created_at, null)
  assert.equal("updated_at" in firstPage[1].repo, false)
  assert.equal(secondPage[0].repo.license?.spdx_id, "NOASSERTION")
})

test("parser rejects the default repository representation without starred_at", () => {
  const defaultRepresentation = firstPage.map((star) => star.repo)
  assert.throws(
    () => parseStarredRepositories(defaultRepresentation),
    /star media-type envelope/
  )
})

test("parser normalizes optional fields and rejects malformed values", () => {
  const unsafeId = structuredClone(firstPagePayload) as Array<{
    repo: { id: number }
  }>
  unsafeId[0].repo.id = Number.MAX_SAFE_INTEGER + 1
  assert.throws(
    () => parseStarredRepositories(unsafeId),
    /invalid repository ID/
  )

  const malformedTopics = structuredClone(firstPagePayload) as Array<{
    repo: { topics?: unknown[] }
  }>
  malformedTopics[0].repo.topics = ["valid", 42]
  assert.throws(
    () => parseStarredRepositories(malformedTopics),
    /invalid repository topics/
  )

  const malformedCreatedAt = structuredClone(firstPagePayload) as Array<{
    repo: { created_at: unknown }
  }>
  malformedCreatedAt[0].repo.created_at = "not-a-timestamp"
  assert.throws(
    () => parseStarredRepositories(malformedCreatedAt),
    /invalid repository created_at/
  )

  const duplicate = structuredClone(firstPagePayload) as Array<{
    repo: { id: number }
  }>
  duplicate[1].repo.id = duplicate[0].repo.id
  assert.throws(
    () => parseStarredRepositories(duplicate),
    /duplicate repository ID/
  )
})

test("repository transform uses the immutable numeric ID and maps useful fields", () => {
  const change = repositoryToChange(firstPage[0])

  assert.equal(change.type, "upsert")
  assert.equal(change.key, "1296269")
  assert.ok(
    propertyIncludes(change.properties.Repository, "octocat/Hello-World")
  )
  assert.ok(propertyIncludes(change.properties.Owner, "octocat"))
  assert.ok(propertyIncludes(change.properties.Description, "small repository"))
  assert.ok(propertyIncludes(change.properties.Language, "TypeScript"))
  assert.ok(propertyIncludes(change.properties.Topics, "api"))
  assert.ok(propertyIncludes(change.properties.Topics, "example"))
  assert.ok(propertyIncludes(change.properties.Visibility, "Public"))
  assert.ok(propertyIncludes(change.properties.License, "MIT"))
  assert.ok(propertyIncludes(change.properties["Starred at"], "2024-01-15"))
  assert.ok(propertyIncludes(change.properties["Last pushed"], "2024-07-01"))
  assert.ok(propertyIncludes(change.properties["Repository ID"], "1296269"))
  assert.equal("pageContentMarkdown" in change, false)

  const serializedTopics = JSON.stringify(change.properties.Topics)
  assert.equal(serializedTopics.match(/api/g)?.length, 1)
})

test("repository key survives rename and re-starring updates the source date", () => {
  const renamed: GitHubStarredRepository = structuredClone(firstPage[0])
  renamed.repo.full_name = "octocat/renamed-repository"
  renamed.starred_at = "2026-01-02T03:04:05Z"

  const change = repositoryToChange(renamed)
  assert.equal(change.key, "1296269")
  assert.ok(
    propertyIncludes(change.properties.Repository, "renamed-repository")
  )
  assert.ok(propertyIncludes(change.properties["Starred at"], "2026-01-02"))
})

test("nullable upstream fields are explicitly cleared without touching page notes", () => {
  const change = repositoryToChange(firstPage[1])

  assert.ok(isEmptyProperty(change.properties.Description))
  assert.ok(isEmptyProperty(change.properties.Homepage))
  assert.ok(isEmptyProperty(change.properties.Language))
  assert.ok(isEmptyProperty(change.properties.Topics))
  assert.ok(isEmptyProperty(change.properties.License))
  assert.ok(isEmptyProperty(change.properties["Last pushed"]))
  assert.ok(isEmptyProperty(change.properties["Repository created"]))
  assert.ok(propertyIncludes(change.properties.Archived, "Yes"))
  assert.ok(propertyIncludes(change.properties.Fork, "Yes"))
  assert.equal("pageContentMarkdown" in change, false)
})

test("worker manifest exposes one hourly inventory and a decision-first schema", () => {
  assert.equal(PRIMARY_KEY, "Repository ID")
  assert.deepEqual(Object.keys(repositorySchema.properties), [
    "Repository",
    "Description",
    "Owner",
    "Starred at",
    "Last pushed",
    "Stars",
    "Archived",
    "Topics",
    "Language",
    "Repository link",
    "Homepage",
    "License",
    "Visibility",
    "Fork",
    "Forks",
    "Open issues and PRs",
    "Repository created",
    "Default branch",
    "Repository ID",
  ])

  assert.deepEqual(
    worker.manifest.databases.map((database) => ({
      key: database.key,
      type: database.config.type,
      title: database.config.initialTitle,
      primaryKey: database.config.primaryKeyProperty,
      icon: database.config.schema.databaseIcon,
    })),
    [
      {
        key: "starredRepositories",
        type: "managed",
        title: "GitHub Starred Repositories",
        primaryKey: "Repository ID",
        icon: { type: "notion", icon: "star", color: "gray" },
      },
    ]
  )

  const capability = worker.manifest.capabilities.find(
    (candidate) => candidate.key === "starredRepositoriesSync"
  )
  assert.ok(capability)
  assert.equal(capability._tag, "sync")
  const config = capability.config as {
    databaseKey: string
    primaryKeyProperty: string
    mode: string
    schedule: { type: string; intervalMs: number }
  }
  assert.deepEqual(config, {
    databaseKey: "starredRepositories",
    primaryKeyProperty: "Repository ID",
    mode: "incremental",
    schedule: { type: "interval", intervalMs: 60 * 60_000 },
  })
  assert.deepEqual(worker.manifest.pacers, [
    {
      key: "github",
      config: { allowedRequests: 4_800, intervalMs: 3_600_000 },
    },
  ])
})

test("GitHub client sends a read-only star-media request and follows Link pages", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = []
  let pacingCalls = 0
  let tokenCalls = 0
  let accountCalls = 0
  const callOrder: string[] = []
  const client = createGitHubStarsClient({
    beforeRequest: async () => {
      pacingCalls += 1
      callOrder.push("pace")
    },
    getAccessToken: async () => {
      tokenCalls += 1
      callOrder.push("token")
      return "test-token-never-log"
    },
    getExpectedUserId: () => {
      accountCalls += 1
      callOrder.push("account")
      return EXPECTED_USER_ID
    },
    fetchImplementation: queuedFetch(
      [
        authenticatedUserResponse(),
        new Response(JSON.stringify(firstPagePayload), {
          status: 200,
          headers: {
            Link: `<https://api.github.com/user/starred?sort=created&direction=asc&per_page=100&page=2>; rel="next", <https://api.github.com/user/starred?sort=created&direction=asc&per_page=100&page=2>; rel="last"`,
          },
        }),
        authenticatedUserResponse(),
        new Response(JSON.stringify(secondPagePayload), {
          status: 200,
        }),
      ],
      calls
    ),
  })

  const pageOne = await client.fetchPage(1)
  const pageTwo = await client.fetchPage(pageOne.nextPage ?? 0)

  assert.equal(pageOne.repositories.length, 2)
  assert.equal(pageOne.nextPage, 2)
  assert.equal(pageTwo.repositories.length, 1)
  assert.equal(pageTwo.nextPage, undefined)
  assert.equal(pageOne.authenticatedUserId, EXPECTED_USER_ID)
  assert.equal(pageTwo.authenticatedUserId, EXPECTED_USER_ID)
  assert.equal(pacingCalls, 4)
  assert.equal(tokenCalls, 2)
  assert.equal(accountCalls, 2)
  assert.deepEqual(callOrder, [
    "account",
    "token",
    "pace",
    "pace",
    "account",
    "token",
    "pace",
    "pace",
  ])
  assert.equal(calls.length, 4)

  const userUrl = new URL(String(calls[0].input))
  assert.equal(userUrl.pathname, "/user")
  const starUrl = new URL(String(calls[1].input))
  assert.equal(starUrl.pathname, "/user/starred")
  assert.equal(starUrl.searchParams.get("sort"), "created")
  assert.equal(starUrl.searchParams.get("direction"), "asc")
  assert.equal(starUrl.searchParams.get("per_page"), String(GITHUB_PAGE_SIZE))
  assert.equal(starUrl.searchParams.get("page"), "1")

  const userHeaders = new Headers(calls[0].init?.headers)
  const starHeaders = new Headers(calls[1].init?.headers)
  assert.equal(userHeaders.get("Accept"), "application/vnd.github+json")
  assert.equal(starHeaders.get("Accept"), GITHUB_STAR_MEDIA_TYPE)
  for (const headers of [userHeaders, starHeaders]) {
    assert.equal(headers.get("Authorization"), "Bearer test-token-never-log")
    assert.equal(headers.get("X-GitHub-Api-Version"), GITHUB_API_VERSION)
    assert.match(headers.get("User-Agent") ?? "", /github-stars-sync/)
  }
  assert.equal(calls[1].init?.method, undefined)
  assert.equal(calls[1].init?.redirect, "error")
  assert.ok(calls[0].init?.signal instanceof AbortSignal)
  assert.ok(calls[1].init?.signal instanceof AbortSignal)
  assert.equal(calls[0].init?.signal?.aborted, false)
  assert.equal(GITHUB_REQUEST_TIMEOUT_MS, 30_000)
})

test("GitHub client rejects malformed pagination before a truncated inventory can finish", async () => {
  assert.throws(
    () =>
      nextPageFromLink(
        '<https://evil.example/user/starred?page=2>; rel="next"',
        1
      ),
    /invalid next link/
  )
  assert.throws(
    () =>
      nextPageFromLink(
        '<https://api.github.com/user/starred?page=1>; rel="next"',
        1
      ),
    /invalid next page/
  )
  assert.throws(
    () =>
      nextPageFromLink(
        '<https://api.github.com/user/starred?page=3>; rel="next"',
        1
      ),
    /invalid next page/
  )
  assert.throws(
    () =>
      nextPageFromLink(
        `<https://api.github.com/user/starred?page=${MAX_STAR_PAGES + 1}>; rel="next"`,
        MAX_STAR_PAGES
      ),
    /invalid next page/
  )

  const malformedClient = createGitHubStarsClient({
    beforeRequest: async () => {},
    getAccessToken: async () => "token",
    getExpectedUserId: () => EXPECTED_USER_ID,
    fetchImplementation: queuedFetch([
      authenticatedUserResponse(),
      new Response(JSON.stringify(firstPagePayload), {
        status: 200,
        headers: {
          Link: '<https://api.github.com/user/starred?page=1>; rel="next"',
        },
      }),
    ]),
  })
  await assert.rejects(() => malformedClient.fetchPage(1), /invalid next page/)
})

test("GitHub client bounds response bodies before parsing or surfacing errors", async () => {
  const oversized = createGitHubStarsClient({
    beforeRequest: async () => {},
    getAccessToken: async () => "secret-token-value",
    getExpectedUserId: () => EXPECTED_USER_ID,
    fetchImplementation: queuedFetch([
      new Response("x".repeat(MAX_GITHUB_RESPONSE_BYTES + 1), {
        status: 502,
      }),
    ]),
  })

  const oversizedError = await captureError(() => oversized.fetchPage(1))
  assert.ok(oversizedError instanceof Error)
  assert.match(oversizedError.message, /response exceeds.*safety limit/)
  assert.doesNotMatch(oversizedError.message, /secret-token-value/)

  const declaredOversized = createGitHubStarsClient({
    beforeRequest: async () => {},
    getAccessToken: async () => "token",
    getExpectedUserId: () => EXPECTED_USER_ID,
    fetchImplementation: queuedFetch([
      new Response("small body", {
        status: 502,
        headers: {
          "Content-Length": String(MAX_GITHUB_RESPONSE_BYTES + 1),
        },
      }),
    ]),
  })
  await assert.rejects(
    () => declaredOversized.fetchPage(1),
    /response exceeds.*safety limit/
  )
})

test("GitHub client verifies the configured account before reading stars", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = []
  const mismatched = createGitHubStarsClient({
    beforeRequest: async () => {},
    getAccessToken: async () => "secret-token-value",
    getExpectedUserId: () => EXPECTED_USER_ID,
    fetchImplementation: queuedFetch(
      [authenticatedUserResponse("991337")],
      calls
    ),
  })

  const mismatch = await captureError(() => mismatched.fetchPage(1))
  assert.ok(mismatch instanceof Error)
  assert.match(mismatch.message, /does not belong to GITHUB_USER_ID/)
  assert.doesNotMatch(mismatch.message, /secret-token-value/)
  assert.equal(calls.length, 1)
  assert.equal(new URL(String(calls[0].input)).pathname, "/user")

  let tokenCalls = 0
  const invalidConfiguration = createGitHubStarsClient({
    beforeRequest: async () => {},
    getAccessToken: async () => {
      tokenCalls += 1
      return "token"
    },
    getExpectedUserId: () => "octocat",
    fetchImplementation: queuedFetch([]),
  })
  await assert.rejects(
    () => invalidConfiguration.fetchPage(1),
    /positive numeric GitHub user ID/
  )
  assert.equal(tokenCalls, 0)
})

test("GitHub client times out a stalled request without exposing credentials", async () => {
  let observedSignal: AbortSignal | undefined
  const hangingFetch = (async (
    _input: string | URL | Request,
    init?: RequestInit
  ) => {
    const signal = init?.signal
    assert.ok(signal instanceof AbortSignal)
    observedSignal = signal
    return new Promise<Response>((_resolve, reject) => {
      // AbortSignal.timeout() intentionally uses an unref'ed timer. Keep this
      // mock transport alive so the test observes the abort like real I/O.
      const fallback = setTimeout(
        () => reject(new Error("mock transport did not receive an abort")),
        1_000
      )
      const rejectWithReason = () => {
        clearTimeout(fallback)
        reject(signal.reason)
      }
      if (signal.aborted) rejectWithReason()
      else signal.addEventListener("abort", rejectWithReason, { once: true })
    })
  }) as FetchImplementation
  const client = createGitHubStarsClient({
    beforeRequest: async () => {},
    getAccessToken: async () => "secret-token-value",
    getExpectedUserId: () => EXPECTED_USER_ID,
    fetchImplementation: hangingFetch,
    requestTimeoutMs: 5,
  })

  const error = await captureError(() => client.fetchPage(1))
  assert.ok(error instanceof Error)
  assert.match(error.message, /timed out after 5 milliseconds/)
  assert.doesNotMatch(error.message, /secret-token-value/)
  assert.equal(observedSignal?.aborted, true)

  const stalledBodyFetch = (async (
    _input: string | URL | Request,
    init?: RequestInit
  ) => {
    const signal = init?.signal
    assert.ok(signal instanceof AbortSignal)
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const fallback = setTimeout(
            () => controller.error(new Error("mock body was not aborted")),
            1_000
          )
          const failOnAbort = () => {
            clearTimeout(fallback)
            controller.error(signal.reason)
          }
          if (signal.aborted) failOnAbort()
          else signal.addEventListener("abort", failOnAbort, { once: true })
        },
      })
    )
  }) as FetchImplementation
  const stalledBody = createGitHubStarsClient({
    beforeRequest: async () => {},
    getAccessToken: async () => "secret-token-value",
    getExpectedUserId: () => EXPECTED_USER_ID,
    fetchImplementation: stalledBodyFetch,
    requestTimeoutMs: 5,
  })
  await assert.rejects(
    () => stalledBody.fetchPage(1),
    /timed out after 5 milliseconds/
  )

  const invalidTimeout = createGitHubStarsClient({
    beforeRequest: async () => {},
    getAccessToken: async () => "token",
    getExpectedUserId: () => EXPECTED_USER_ID,
    fetchImplementation: queuedFetch([]),
    requestTimeoutMs: 0,
  })
  await assert.rejects(
    () => invalidTimeout.fetchPage(1),
    /request timeout must be a positive integer/
  )
})

test("GitHub client surfaces provider rate-limit timing without leaking credentials", async () => {
  const rateLimited = createGitHubStarsClient({
    beforeRequest: async () => {},
    getAccessToken: async () => "secret-token-value",
    getExpectedUserId: () => EXPECTED_USER_ID,
    fetchImplementation: queuedFetch([
      new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 429,
        headers: { "Retry-After": "7" },
      }),
    ]),
  })

  const rateLimitError = await captureError(() => rateLimited.fetchPage(1))
  assert.ok(rateLimitError instanceof RateLimitError)
  assert.equal(rateLimitError.retryAfter, 7)

  const exhaustedWithoutReset = createGitHubStarsClient({
    beforeRequest: async () => {},
    getAccessToken: async () => "secret-token-value",
    getExpectedUserId: () => EXPECTED_USER_ID,
    fetchImplementation: queuedFetch([
      new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: { "X-RateLimit-Remaining": "0" },
      }),
    ]),
  })
  const missingResetError = await captureError(() =>
    exhaustedWithoutReset.fetchPage(1)
  )
  assert.ok(missingResetError instanceof RateLimitError)
  assert.equal(missingResetError.retryAfter, 60)

  const forbidden = createGitHubStarsClient({
    beforeRequest: async () => {},
    getAccessToken: async () => "secret-token-value",
    getExpectedUserId: () => EXPECTED_USER_ID,
    fetchImplementation: queuedFetch([
      new Response(JSON.stringify({ message: "Resource not accessible" }), {
        status: 403,
      }),
    ]),
  })
  const forbiddenError = await captureError(() => forbidden.fetchPage(1))
  assert.ok(forbiddenError instanceof Error)
  assert.ok(!(forbiddenError instanceof RateLimitError))
  assert.match(forbiddenError.message, /GitHub API error \(403\)/)
  assert.doesNotMatch(forbiddenError.message, /secret-token-value/)
})

type ScriptedStarsPage = {
  page: number
  repositories: GitHubStarredRepository[]
  nextPage?: number
  accountId?: string
}

function scriptedStarsClient(
  scriptedPages: ScriptedStarsPage[],
  calls: number[] = []
): GitHubStarsClient {
  return {
    async fetchPage(page) {
      calls.push(page)
      const scripted = scriptedPages.shift()
      assert.ok(scripted, "mock stars page queue was exhausted")
      assert.equal(page, scripted.page)
      return {
        authenticatedUserId: scripted.accountId ?? EXPECTED_USER_ID,
        repositories: scripted.repositories,
        nextPage: scripted.nextPage,
      }
    },
  }
}

function deletedKeys(changes: ReadonlyArray<{ type: string; key: string }>) {
  return changes
    .filter((change) => change.type === "delete")
    .map((change) => change.key)
}

test("hourly inventory persists a terminal checkpoint without deleting", async () => {
  const calls: number[] = []
  const client = scriptedStarsClient(
    [
      { page: 1, repositories: firstPage, nextPage: 2 },
      { page: 2, repositories: secondPage },
    ],
    calls
  )

  const first = await runStarsSyncPage(client, undefined)
  assert.equal(first.hasMore, true)
  assert.equal(first.changes.length, 2)
  assert.equal(first.nextState.phase, "scan")
  assert.equal(pageFromState(first.nextState), 2)

  const second = await runStarsSyncPage(client, first.nextState)
  assert.equal(second.hasMore, false)
  assert.equal(second.nextState.phase, "ready")
  assert.equal(pageFromState(second.nextState), 1)
  assert.equal(second.changes.length, 1)
  assert.deepEqual(deletedKeys(second.changes), [])
  assert.deepEqual(calls, [1, 2])
})

test("membership changes recover from persisted state and delay deletion", async () => {
  const [one, two, three] = [1, 2, 3].map(starWithId)
  const client = scriptedStarsClient([
    { page: 1, repositories: [one, two] },
    { page: 1, repositories: [one, three] },
    { page: 1, repositories: [one, three] },
  ])

  const initial = await runStarsSyncPage(client, undefined)
  assert.equal(initial.hasMore, false)
  const firstAbsence = await runStarsSyncPage(client, initial.nextState)
  assert.equal(firstAbsence.hasMore, false)
  assert.deepEqual(deletedKeys(firstAbsence.changes), [])

  // The terminal state from [1,3] is persisted. Retrying the next scheduled
  // inventory does not compare against a stranded [1,2] confirmation digest.
  const confirmedAbsence = await runStarsSyncPage(
    client,
    firstAbsence.nextState
  )
  assert.equal(confirmedAbsence.hasMore, false)
  assert.deepEqual(deletedKeys(confirmedAbsence.changes), ["2"])
})

test("a reappearing repository cancels its absence evidence", async () => {
  const [one, two, three] = [1, 2, 3].map(starWithId)
  const client = scriptedStarsClient([
    { page: 1, repositories: [one, two] },
    { page: 1, repositories: [one, three] },
    { page: 1, repositories: [one, two] },
    { page: 1, repositories: [one, three] },
  ])

  const initial = await runStarsSyncPage(client, undefined)
  const missingOnce = await runStarsSyncPage(client, initial.nextState)
  const reappeared = await runStarsSyncPage(client, missingOnce.nextState)
  assert.deepEqual(deletedKeys(reappeared.changes), [])

  const missingAgain = await runStarsSyncPage(client, reappeared.nextState)
  assert.deepEqual(deletedKeys(missingAgain.changes), [])
})

test("one offset-shifted inventory cannot delete a currently starred repository", async () => {
  const [a, b, c, d] = [101, 102, 103, 104].map(starWithId)
  const client = scriptedStarsClient([
    { page: 1, repositories: [a, b, c, d] },
    // C shifts onto an already-read page and is absent from this completed
    // inventory. Incremental mode records only first-absence evidence.
    { page: 1, repositories: [a, b], nextPage: 2 },
    { page: 2, repositories: [d] },
    { page: 1, repositories: [a, b, c, d] },
  ])

  const initial = await runStarsSyncPage(client, undefined)
  const shiftedFirstPage = await runStarsSyncPage(client, initial.nextState)
  assert.equal(shiftedFirstPage.hasMore, true)
  const shiftedTerminal = await runStarsSyncPage(
    client,
    shiftedFirstPage.nextState
  )
  assert.equal(shiftedTerminal.hasMore, false)
  assert.deepEqual(deletedKeys(shiftedTerminal.changes), [])

  const recovered = await runStarsSyncPage(client, shiftedTerminal.nextState)
  assert.deepEqual(deletedKeys(recovered.changes), [])
})

test("cross-page duplicates abort safely and the next schedule recovers", async () => {
  const [a, b, c] = [101, 102, 103].map(starWithId)
  const client = scriptedStarsClient([
    { page: 1, repositories: [a, b, c] },
    { page: 1, repositories: [a, b] },
    { page: 1, repositories: [a, b], nextPage: 2 },
    // B proves that this page shifted, but C appears later in the same page.
    // The abort must still clear C's existing first-absence evidence.
    { page: 2, repositories: [b, c] },
    { page: 1, repositories: [a, b] },
  ])

  const initial = await runStarsSyncPage(client, undefined)
  const missingOnce = await runStarsSyncPage(client, initial.nextState)
  assert.deepEqual(deletedKeys(missingOnce.changes), [])
  const unstable = await runStarsSyncPage(client, missingOnce.nextState)
  assert.equal(unstable.hasMore, true)
  const aborted = await runStarsSyncPage(client, unstable.nextState)
  assert.equal(aborted.hasMore, false)
  assert.equal(aborted.nextState.phase, "ready")
  assert.deepEqual(aborted.changes, [])

  const recovered = await runStarsSyncPage(client, aborted.nextState)
  assert.equal(recovered.hasMore, false)
  assert.deepEqual(deletedKeys(recovered.changes), [])
})

test("packed worst-case state remains below the Worker limit", () => {
  const active = Array.from(
    { length: MAX_TRACKED_REPOSITORIES / 2 },
    (_, i) => i + 1
  )
  const missing = Array.from(
    { length: MAX_TRACKED_REPOSITORIES / 2 },
    (_, i) => active.length + i + 1
  )
  const state = createReadyState(EXPECTED_USER_ID, active, missing)
  const bytes = starsSyncStateSize(state)
  assert.ok(
    bytes < MAX_SAFE_STARS_SYNC_STATE_BYTES,
    `${bytes} is not below 240 KiB`
  )
  assert.ok(bytes < 256 * 1_024, `${bytes} is not below 256 KiB`)
  assert.equal(JSON.stringify(state).includes(active.join(",")), false)
})

test("state-cap recovery preserves existing deletion evidence", async () => {
  const active = Array.from(
    { length: MAX_TRACKED_REPOSITORIES / 2 },
    (_, index) => index + 1
  )
  const missing = Array.from(
    { length: MAX_TRACKED_REPOSITORIES / 2 },
    (_, index) => active.length + index + 1
  )
  const ready = createReadyState(EXPECTED_USER_ID, active, missing)
  const newStars = Array.from({ length: GITHUB_PAGE_SIZE }, (_, index) =>
    starWithId(MAX_TRACKED_REPOSITORIES + index + 1)
  )
  const client = scriptedStarsClient([
    { page: 1, repositories: newStars, nextPage: 2 },
  ])

  const aborted = await runStarsSyncPage(client, ready)
  assert.equal(aborted.hasMore, false)
  assert.deepEqual(aborted.changes, [])
  assert.deepEqual(aborted.nextState, ready)
})

test("account identity cannot change during an inventory scan", async () => {
  let call = 0
  const client: GitHubStarsClient = {
    async fetchPage(page) {
      call += 1
      return {
        authenticatedUserId: call === 1 ? EXPECTED_USER_ID : "991337",
        repositories: page === 1 ? firstPage : secondPage,
        nextPage: page === 1 ? 2 : undefined,
      }
    },
  }

  const first = await runStarsSyncPage(client, undefined)
  assert.equal(first.hasMore, true)
  if (!first.hasMore) return
  await assert.rejects(
    () => runStarsSyncPage(client, first.nextState),
    /account changed during the inventory scan/
  )
})

test("invalid or incompatible sync state fails before requesting GitHub", async () => {
  const validState = createReadyState(
    EXPECTED_USER_ID,
    [firstPage[0].repo.id],
    []
  )
  assert.equal(pageFromState(undefined), 1)
  assert.equal(pageFromState(validState), 1)
  assert.throws(
    () => pageFromState({ ...validState, stateVersion: 99 } as never),
    /incompatible/
  )
  assert.throws(
    () => pageFromState({ ...validState, accountId: "not-a-user" }),
    /invalid account ID/
  )
  assert.throws(
    () => pageFromState({ ...validState, repositoryIds: "not-base64!" }),
    /invalid repository IDs/
  )

  let requested = false
  const client: GitHubStarsClient = {
    async fetchPage() {
      requested = true
      return {
        authenticatedUserId: EXPECTED_USER_ID,
        repositories: [],
        nextPage: undefined,
      }
    },
  }
  await assert.rejects(
    () =>
      runStarsSyncPage(client, {
        ...validState,
        phase: "scan",
        page: MAX_STAR_PAGES + 1,
      } as StarsSyncState),
    /invalid page/
  )
  assert.equal(requested, false)
})

test("PAT and GitHub App user OAuth modes stay read-only and defer secrets", async () => {
  assert.equal(getGitHubAuthMode({}), "pat")
  assert.equal(getGitHubAuthMode({ GITHUB_AUTH_MODE: " USER " }), "user")
  assert.throws(
    () => getGitHubAuthMode({ GITHUB_AUTH_MODE: "installation" }),
    /pat.*user/
  )
  assert.equal(
    getExpectedGitHubUserId({ GITHUB_USER_ID: ` ${EXPECTED_USER_ID} ` }),
    EXPECTED_USER_ID
  )
  assert.throws(() => getExpectedGitHubUserId({}), /GITHUB_USER_ID is not set/)
  assert.throws(
    () => getExpectedGitHubUserId({ GITHUB_USER_ID: "octocat" }),
    /positive numeric GitHub user ID/
  )
  assert.throws(
    () => getExpectedGitHubUserId({ GITHUB_USER_ID: "9999999999999999" }),
    /safe integer/
  )

  const configurations: Array<{
    key: string
    config: UserManagedOAuthConfiguration
  }> = []
  let oauthAccessCalls = 0
  const registrar = {
    oauth(key: string, config: UserManagedOAuthConfiguration) {
      configurations.push({ key, config })
      return {
        async accessToken() {
          oauthAccessCalls += 1
          return "oauth-user-token"
        },
      }
    },
  }

  const patProvider = createGitHubAccessTokenProvider(registrar, {
    env: { GITHUB_AUTH_MODE: "pat", GITHUB_TOKEN: " fine-grained-token " },
  })
  assert.equal(await patProvider(), "fine-grained-token")
  assert.equal(oauthAccessCalls, 0)

  const userProvider = createGitHubAccessTokenProvider(registrar, {
    env: {
      GITHUB_AUTH_MODE: "user",
      GITHUB_APP_CLIENT_ID: "Iv1.client",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
    },
  })
  assert.equal(await userProvider(), "oauth-user-token")
  assert.equal(oauthAccessCalls, 1)
  assert.equal(configurations.at(-1)?.key, GITHUB_OAUTH_CAPABILITY_KEY)
  assert.equal(configurations.at(-1)?.config.scope, "")
  assert.equal(
    configurations.at(-1)?.config.authorizationEndpoint,
    "https://github.com/login/oauth/authorize"
  )

  const missingUserSecrets = createGitHubAccessTokenProvider(registrar, {
    env: { GITHUB_AUTH_MODE: "user" },
  })
  await assert.rejects(() => missingUserSecrets(), /GITHUB_APP_CLIENT_ID/)
})
