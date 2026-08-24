import assert from "node:assert/strict"
import test from "node:test"

import {
  GitHubApiError,
  GitHubClient,
  GitHubPreconditionError,
  GitHubPublishedPostconditionError,
} from "../src/github.js"

const REPOSITORY = "acme/widget"
const REPOSITORY_ID = 42
const RELEASE_ID = 7
const TAG_COMMIT = "a".repeat(40)

type ReleaseJson = {
  id: number
  html_url: string
  tag_name: string
  name: string | null
  body: string | null
  draft: boolean
  prerelease: boolean
  created_at: string
  published_at: string | null
}

type AssetJson = {
  id: number
  name: string
  label: string | null
  state: string
  size: number
  digest: string | null
}

type Call = { method: string; url: string; body: unknown }

type FixtureOptions = {
  repositoryId?: number
  release?: Partial<ReleaseJson>
  assets?: AssetJson[]
  annotatedTag?: boolean
  missingTag?: boolean
  hasMoreAssets?: boolean
  releasePage?: number
  releasePages?: ReleaseJson[][]
  hasMoreReleasePages?: boolean
  latestBefore?: number | null
  latestAfter?: number | null
  failLatestAfterPatch?: boolean
  patchMode?:
    | "success"
    | "409-published"
    | "409-draft"
    | "timeout-published"
    | "success-drift"
    | "success-readback-failure"
}

function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input)
}

function listedRelease(
  id: number,
  overrides: Partial<ReleaseJson> = {}
): ReleaseJson {
  return {
    id,
    html_url: `https://github.com/${REPOSITORY}/releases/tag/v${id}`,
    tag_name: `v${id}`,
    name: `Version ${id}`,
    body: `Notes ${id}`,
    draft: true,
    prerelease: false,
    created_at: `2026-07-${String((id % 28) + 1).padStart(2, "0")}T12:00:00Z`,
    published_at: null,
    ...overrides,
  }
}

function releaseFixture(options: FixtureOptions = {}) {
  let release: ReleaseJson = {
    id: RELEASE_ID,
    html_url: `https://github.com/${REPOSITORY}/releases/tag/v1.0.0`,
    tag_name: "v1.0.0",
    name: "Version 1.0.0",
    body: "Highlights",
    draft: true,
    prerelease: false,
    created_at: "2026-07-04T12:00:00Z",
    published_at: null,
    ...options.release,
  }
  const assets = options.assets ?? [
    {
      id: 1,
      name: "widget.tgz",
      label: "Node package",
      state: "uploaded",
      size: 128,
      digest: `sha256:${"b".repeat(64)}`,
    },
  ]
  const calls: Call[] = []
  let afterPatch = false
  let latestReleaseId: number | null = options.latestBefore ?? 6
  if (options.latestBefore === null) latestReleaseId = null
  const hasLatestAfter = Object.prototype.hasOwnProperty.call(
    options,
    "latestAfter"
  )

  const fetch = (async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const url = new URL(requestUrl(input))
    const method = init.method ?? "GET"
    const body =
      typeof init.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ method, url: url.toString(), body })

    if (url.pathname === `/repos/${REPOSITORY}` && method === "GET") {
      return json({
        id: options.repositoryId ?? REPOSITORY_ID,
        full_name: REPOSITORY,
        archived: false,
        disabled: false,
      })
    }
    if (url.pathname === `/repos/${REPOSITORY}/releases` && method === "GET") {
      const page = Number(url.searchParams.get("page") ?? "1")
      if (options.releasePages) {
        const pageReleases = options.releasePages[page - 1] ?? []
        const hasNext =
          page < options.releasePages.length ||
          (page === options.releasePages.length &&
            options.hasMoreReleasePages === true)
        return json(pageReleases, 200, {
          ...(hasNext
            ? {
                Link: `<https://api.github.test/repos/${REPOSITORY}/releases?per_page=100&page=${page + 1}>; rel="next"`,
              }
            : {}),
        })
      }
      const releasePage = options.releasePage ?? 1
      return json(page === releasePage ? [release] : [], 200, {
        ...(page < releasePage
          ? {
              Link: `<https://api.github.test/repos/${REPOSITORY}/releases?per_page=100&page=${page + 1}>; rel="next"`,
            }
          : {}),
      })
    }
    if (
      url.pathname === `/repos/${REPOSITORY}/releases/latest` &&
      method === "GET"
    ) {
      if (afterPatch && options.failLatestAfterPatch) {
        return json({ message: "latest unavailable" }, 503, {
          "X-GitHub-Request-Id": "latest-failure",
        })
      }
      return latestReleaseId === null
        ? json({ message: "no releases" }, 404, {
            "X-GitHub-Request-Id": "latest-missing",
          })
        : json({ id: latestReleaseId }, 200, {
            "X-GitHub-Request-Id": "latest-request",
          })
    }
    if (
      url.pathname === `/repos/${REPOSITORY}/releases/${RELEASE_ID}` &&
      method === "GET"
    ) {
      if (afterPatch && options.patchMode === "success-readback-failure") {
        return json({ message: "provider detail must stay private" }, 503, {
          "X-GitHub-Request-Id": "readback-request",
        })
      }
      return json(release)
    }
    if (
      url.pathname === `/repos/${REPOSITORY}/releases/${RELEASE_ID}/assets` &&
      method === "GET"
    ) {
      return json(
        assets,
        200,
        options.hasMoreAssets
          ? {
              Link: `<https://api.github.test/repos/${REPOSITORY}/releases/${RELEASE_ID}/assets?page=2>; rel="next"`,
            }
          : {}
      )
    }
    if (
      url.pathname === `/repos/${REPOSITORY}/git/ref/tags/v1.0.0` &&
      method === "GET"
    ) {
      if (options.missingTag) return json({ message: "missing" }, 404)
      return json({
        ref: "refs/tags/v1.0.0",
        object: options.annotatedTag
          ? { type: "tag", sha: "tag-object" }
          : { type: "commit", sha: TAG_COMMIT },
      })
    }
    if (
      url.pathname === `/repos/${REPOSITORY}/git/tags/tag-object` &&
      method === "GET"
    ) {
      return json({ object: { type: "commit", sha: TAG_COMMIT } })
    }
    if (
      url.pathname === `/repos/${REPOSITORY}/releases/${RELEASE_ID}` &&
      method === "PATCH"
    ) {
      afterPatch = true
      const mode = options.patchMode ?? "success"
      if (mode !== "409-draft") {
        if (hasLatestAfter) {
          latestReleaseId = options.latestAfter ?? null
        } else if (
          typeof body === "object" &&
          body !== null &&
          "make_latest" in body &&
          body.make_latest === "true"
        ) {
          latestReleaseId = RELEASE_ID
        }
      }
      if (mode !== "409-draft") {
        release = {
          ...release,
          draft: false,
          published_at: "2026-07-05T12:00:00Z",
          ...(mode === "success-drift"
            ? { body: "Changed during publication" }
            : {}),
        }
      }
      if (mode === "timeout-published") {
        throw new DOMException("timed out", "AbortError")
      }
      if (mode === "409-published" || mode === "409-draft") {
        return json({ message: "conflict" }, 409, {
          "X-GitHub-Request-Id": "patch-conflict",
        })
      }
      return json(release, 200, {
        "X-GitHub-Request-Id": "patch-success",
      })
    }

    throw new Error(`Unexpected GitHub request: ${method} ${url.pathname}`)
  }) as typeof globalThis.fetch

  return {
    fetch,
    calls,
    setRelease(update: Partial<ReleaseJson>) {
      release = { ...release, ...update }
    },
  }
}

function client(
  fetch: typeof globalThis.fetch,
  getAccessToken = async () => "token"
): GitHubClient {
  return new GitHubClient({
    repository: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    getAccessToken,
    fetch,
    apiBaseUrl: "https://api.github.test",
    sleep: async () => undefined,
  })
}

function patchCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.method === "PATCH")
}

test("inspection versions exact release content independent of asset order", async () => {
  const firstAsset: AssetJson = {
    id: 1,
    name: "a.zip",
    label: "macOS",
    state: "uploaded",
    size: 10,
    digest: `sha256:${"1".repeat(64)}`,
  }
  const secondAsset: AssetJson = {
    id: 2,
    name: "b.zip",
    label: null,
    state: "uploaded",
    size: 20,
    digest: null,
  }
  const first = await client(
    releaseFixture({ assets: [secondAsset, firstAsset] }).fetch
  ).inspectRelease(RELEASE_ID)
  const reordered = await client(
    releaseFixture({ assets: [firstAsset, secondAsset] }).fetch
  ).inspectRelease(RELEASE_ID)
  const relabeled = await client(
    releaseFixture({
      assets: [{ ...firstAsset, label: "Universal" }, secondAsset],
    }).fetch
  ).inspectRelease(RELEASE_ID)
  const redigested = await client(
    releaseFixture({
      assets: [
        { ...firstAsset, digest: `sha256:${"2".repeat(64)}` },
        secondAsset,
      ],
    }).fetch
  ).inspectRelease(RELEASE_ID)

  assert.deepEqual(
    first.assets.map((asset) => asset.name),
    ["a.zip", "b.zip"]
  )
  assert.equal(first.version, reordered.version)
  assert.notEqual(first.version, relabeled.version)
  assert.notEqual(first.version, redigested.version)
})

test("draft discovery is bounded and honest about incomplete results", async (t) => {
  await t.test(
    "filters published releases and returns lightweight drafts",
    async () => {
      const firstDraft = listedRelease(101)
      const secondDraft = listedRelease(103, {
        name: null,
        prerelease: true,
      })
      const fixture = releaseFixture({
        releasePages: [
          [
            firstDraft,
            listedRelease(102, {
              draft: false,
              published_at: "2026-07-05T12:00:00Z",
            }),
            secondDraft,
          ],
        ],
      })

      const result = await client(fixture.fetch).listDraftReleases()

      assert.equal(result.repository, REPOSITORY)
      assert.equal(result.hasMore, false)
      assert.deepEqual(result.drafts, [
        {
          releaseId: firstDraft.id,
          tag: firstDraft.tag_name,
          name: firstDraft.name,
          htmlUrl: firstDraft.html_url,
          prerelease: false,
          createdAt: firstDraft.created_at,
        },
        {
          releaseId: secondDraft.id,
          tag: secondDraft.tag_name,
          name: "",
          htmlUrl: secondDraft.html_url,
          prerelease: true,
          createdAt: secondDraft.created_at,
        },
      ])
    }
  )

  await t.test("returns at most 20 drafts", async () => {
    const fixture = releaseFixture({
      releasePages: [
        Array.from({ length: 21 }, (_, index) => listedRelease(200 + index)),
      ],
    })

    const result = await client(fixture.fetch).listDraftReleases()

    assert.equal(result.drafts.length, 20)
    assert.equal(result.hasMore, true)
  })

  await t.test("marks a bounded scan as potentially incomplete", async () => {
    const fixture = releaseFixture({
      releasePages: Array.from({ length: 10 }, (_, index) => [
        listedRelease(300 + index, {
          draft: index === 0,
          published_at: index === 0 ? null : "2026-07-05T12:00:00Z",
        }),
      ]),
      hasMoreReleasePages: true,
    })

    const result = await client(fixture.fetch).listDraftReleases()

    assert.equal(result.drafts.length, 1)
    assert.equal(result.hasMore, true)
    assert.equal(
      fixture.calls.filter(
        (call) => new URL(call.url).pathname === `/repos/${REPOSITORY}/releases`
      ).length,
      10
    )
  })
})

test("draft lookup uses the documented bounded releases list", async (t) => {
  await t.test("finds a paginated draft without an exact-ID GET", async () => {
    const fixture = releaseFixture({ releasePage: 2 })
    const snapshot = await client(fixture.fetch).inspectRelease(RELEASE_ID)

    assert.equal(snapshot.state, "draft")
    assert.equal(
      fixture.calls.filter(
        (call) =>
          call.method === "GET" &&
          new URL(call.url).pathname === `/repos/${REPOSITORY}/releases`
      ).length,
      2
    )
    assert.equal(
      fixture.calls.filter(
        (call) =>
          call.method === "GET" &&
          new URL(call.url).pathname ===
            `/repos/${REPOSITORY}/releases/${RELEASE_ID}`
      ).length,
      0
    )
  })

  await t.test("fails closed after 1,000 releases", async () => {
    const fixture = releaseFixture({ releasePage: 11 })
    await assert.rejects(
      client(fixture.fetch).inspectRelease(RELEASE_ID),
      /most recent 1000 releases/
    )
    assert.equal(
      fixture.calls.filter(
        (call) => new URL(call.url).pathname === `/repos/${REPOSITORY}/releases`
      ).length,
      10
    )
  })

  await t.test(
    "uses an exact-ID GET after observing a public release",
    async () => {
      const fixture = releaseFixture({
        release: {
          draft: false,
          published_at: "2026-07-05T12:00:00Z",
        },
      })
      const snapshot = await client(fixture.fetch).inspectRelease(RELEASE_ID)

      assert.equal(snapshot.state, "published")
      assert.ok(
        fixture.calls.some(
          (call) =>
            call.method === "GET" &&
            new URL(call.url).pathname ===
              `/repos/${REPOSITORY}/releases/${RELEASE_ID}`
        )
      )
    }
  )
})

test("inspection resolves annotated tags", async () => {
  const fixture = releaseFixture({ annotatedTag: true })
  const snapshot = await client(fixture.fetch).inspectRelease(RELEASE_ID)

  assert.equal(snapshot.tagCommit, TAG_COMMIT)
  assert.ok(
    fixture.calls.some((call) => call.url.endsWith("/git/tags/tag-object"))
  )
})

test("inspection fails closed on repository or tag identity", async (t) => {
  await t.test("repository ID mismatch", async () => {
    const fixture = releaseFixture({ repositoryId: 99 })
    await assert.rejects(
      client(fixture.fetch).inspectRelease(RELEASE_ID),
      /repository identity does not match/
    )
  })

  await t.test("missing tag", async () => {
    const fixture = releaseFixture({ missingTag: true })
    await assert.rejects(
      client(fixture.fetch).inspectRelease(RELEASE_ID),
      /tag must exist/
    )
  })
})

test("publication sends one minimal PATCH and stale versions send none", async (t) => {
  await t.test("matching version", async () => {
    const fixture = releaseFixture()
    const github = client(fixture.fetch)
    const inspected = await github.inspectRelease(RELEASE_ID)
    const result = await github.publishRelease({
      releaseId: RELEASE_ID,
      expectedVersion: inspected.version,
      latestBehavior: "make_latest",
    })

    assert.equal(result.changed, true)
    assert.equal(result.snapshot.state, "published")
    assert.deepEqual(
      patchCalls(fixture.calls).map((call) => call.body),
      [{ draft: false, make_latest: "true" }]
    )
    assert.equal(
      fixture.calls.filter(
        (call) =>
          call.method === "GET" &&
          new URL(call.url).pathname === `/repos/${REPOSITORY}/releases`
      ).length,
      2
    )
    assert.equal(
      fixture.calls.filter(
        (call) =>
          call.method === "GET" &&
          new URL(call.url).pathname ===
            `/repos/${REPOSITORY}/releases/${RELEASE_ID}`
      ).length,
      1
    )
  })

  await t.test("stale version", async () => {
    const fixture = releaseFixture()
    const github = client(fixture.fetch)
    const inspected = await github.inspectRelease(RELEASE_ID)
    fixture.setRelease({ body: "Updated notes" })

    await assert.rejects(
      github.publishRelease({
        releaseId: RELEASE_ID,
        expectedVersion: inspected.version,
        latestBehavior: "keep_current",
      }),
      /changed after it was inspected/
    )
    assert.equal(patchCalls(fixture.calls).length, 0)
  })
})

test("publication verifies the requested latest-release behavior", async (t) => {
  await t.test(
    "keep_current preserves the previous latest release",
    async () => {
      const fixture = releaseFixture({ latestBefore: 99 })
      const github = client(fixture.fetch)
      const inspected = await github.inspectRelease(RELEASE_ID)

      const result = await github.publishRelease({
        releaseId: RELEASE_ID,
        expectedVersion: inspected.version,
        latestBehavior: "keep_current",
      })

      assert.equal(result.changed, true)
      assert.deepEqual(
        patchCalls(fixture.calls).map((call) => call.body),
        [{ draft: false, make_latest: "false" }]
      )
      assert.equal(
        fixture.calls.filter(
          (call) =>
            new URL(call.url).pathname ===
            `/repos/${REPOSITORY}/releases/latest`
        ).length,
        2
      )
    }
  )

  await t.test("reports a public release when latest changed", async () => {
    const fixture = releaseFixture({ latestBefore: 99, latestAfter: 100 })
    const github = client(fixture.fetch)
    const inspected = await github.inspectRelease(RELEASE_ID)

    await assert.rejects(
      github.publishRelease({
        releaseId: RELEASE_ID,
        expectedVersion: inspected.version,
        latestBehavior: "keep_current",
      }),
      (error: unknown) => {
        assert.ok(error instanceof GitHubPublishedPostconditionError)
        assert.equal(error.snapshot.state, "published")
        assert.equal(error.retryable, false)
        assert.match(error.message, /latest release changed/)
        return true
      }
    )
  })

  for (const [latestBehavior, retryable] of [
    ["make_latest", true],
    ["keep_current", false],
  ] as const) {
    await t.test(
      `preserves public state when ${latestBehavior} verification fails`,
      async () => {
        const fixture = releaseFixture({ failLatestAfterPatch: true })
        const github = client(fixture.fetch)
        const inspected = await github.inspectRelease(RELEASE_ID)

        await assert.rejects(
          github.publishRelease({
            releaseId: RELEASE_ID,
            expectedVersion: inspected.version,
            latestBehavior,
          }),
          (error: unknown) => {
            assert.ok(error instanceof GitHubPublishedPostconditionError)
            assert.equal(error.snapshot.state, "published")
            assert.equal(error.retryable, retryable)
            assert.equal(error.requestId, "latest-failure")
            return true
          }
        )
      }
    )
  }
})

test("published retries are no-ops and prereleases cannot become latest", async (t) => {
  await t.test("already published", async () => {
    const fixture = releaseFixture()
    const github = client(fixture.fetch)
    const inspected = await github.inspectRelease(RELEASE_ID)
    fixture.setRelease({
      draft: false,
      published_at: "2026-07-05T12:00:00Z",
    })

    const result = await github.publishRelease({
      releaseId: RELEASE_ID,
      expectedVersion: inspected.version,
      latestBehavior: "keep_current",
    })
    assert.equal(result.changed, false)
    assert.equal(result.snapshot.version, inspected.version)
    assert.equal(patchCalls(fixture.calls).length, 0)
  })

  await t.test("already published must be latest when requested", async () => {
    const published = {
      draft: false,
      published_at: "2026-07-05T12:00:00Z",
    }
    const matchingFixture = releaseFixture({
      release: published,
      latestBefore: RELEASE_ID,
    })
    const matchingClient = client(matchingFixture.fetch)
    const matching = await matchingClient.inspectRelease(RELEASE_ID)
    const result = await matchingClient.publishRelease({
      releaseId: RELEASE_ID,
      expectedVersion: matching.version,
      latestBehavior: "make_latest",
    })
    assert.equal(result.changed, false)

    const mismatchFixture = releaseFixture({
      release: published,
      latestBefore: 99,
    })
    const mismatchClient = client(mismatchFixture.fetch)
    const mismatch = await mismatchClient.inspectRelease(RELEASE_ID)
    await assert.rejects(
      mismatchClient.publishRelease({
        releaseId: RELEASE_ID,
        expectedVersion: mismatch.version,
        latestBehavior: "make_latest",
      }),
      /not GitHub's latest release/
    )
    assert.equal(patchCalls(mismatchFixture.calls).length, 0)
  })

  await t.test("prerelease latest conflict", async () => {
    const fixture = releaseFixture({ release: { prerelease: true } })
    const github = client(fixture.fetch)
    const inspected = await github.inspectRelease(RELEASE_ID)

    await assert.rejects(
      github.publishRelease({
        releaseId: RELEASE_ID,
        expectedVersion: inspected.version,
        latestBehavior: "make_latest",
      }),
      /prerelease cannot be published as the latest/
    )
    assert.equal(patchCalls(fixture.calls).length, 0)
  })
})

test("ambiguous PATCH responses reconcile without retrying the write", async (t) => {
  for (const patchMode of ["409-published", "timeout-published"] as const) {
    await t.test(patchMode, async () => {
      const fixture = releaseFixture({ patchMode })
      const github = client(fixture.fetch)
      const inspected = await github.inspectRelease(RELEASE_ID)

      const result = await github.publishRelease({
        releaseId: RELEASE_ID,
        expectedVersion: inspected.version,
        latestBehavior: "keep_current",
      })
      assert.equal(result.snapshot.state, "published")
      assert.equal(result.changed, null)
      assert.equal(patchCalls(fixture.calls).length, 1)
    })
  }
})

test("publication reports a public release whose content drifted", async () => {
  const fixture = releaseFixture({ patchMode: "success-drift" })
  const github = client(fixture.fetch)
  const inspected = await github.inspectRelease(RELEASE_ID)

  await assert.rejects(
    github.publishRelease({
      releaseId: RELEASE_ID,
      expectedVersion: inspected.version,
      latestBehavior: "keep_current",
    }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubPublishedPostconditionError)
      assert.equal(error.snapshot.state, "published")
      assert.equal(error.snapshot.body, "Changed during publication")
      return true
    }
  )
  assert.equal(patchCalls(fixture.calls).length, 1)
})

test("publication remains ambiguous when read-back cannot prove success", async (t) => {
  for (const patchMode of ["409-draft", "success-readback-failure"] as const) {
    await t.test(patchMode, async () => {
      const fixture = releaseFixture({ patchMode })
      const github = client(fixture.fetch)
      const inspected = await github.inspectRelease(RELEASE_ID)

      await assert.rejects(
        github.publishRelease({
          releaseId: RELEASE_ID,
          expectedVersion: inspected.version,
          latestBehavior: "keep_current",
        }),
        (error: unknown) => {
          assert.ok(error instanceof GitHubApiError)
          assert.equal(error.ambiguousMutation, true)
          return true
        }
      )
      assert.equal(patchCalls(fixture.calls).length, 1)
    })
  }
})

test("inspection rejects releases with more than 100 assets", async () => {
  const fixture = releaseFixture({ hasMoreAssets: true })
  await assert.rejects(
    client(fixture.fetch).inspectRelease(RELEASE_ID),
    /more than 100 assets/
  )
})

test("publication retries authentication before sending its single PATCH", async () => {
  const fixture = releaseFixture()
  const inspected = await client(fixture.fetch).inspectRelease(RELEASE_ID)
  fixture.calls.length = 0

  let injectedFailure = false
  let tokenAttempts = 0
  const github = client(fixture.fetch, async () => {
    tokenAttempts++
    const lastPath = fixture.calls.at(-1)
      ? new URL(fixture.calls.at(-1)!.url).pathname
      : null
    if (!injectedFailure && lastPath?.includes("/git/ref/tags/")) {
      injectedFailure = true
      throw new Error("temporary auth failure")
    }
    return "token"
  })

  const result = await github.publishRelease({
    releaseId: RELEASE_ID,
    expectedVersion: inspected.version,
    latestBehavior: "make_latest",
  })

  assert.equal(result.changed, true)
  assert.equal(injectedFailure, true)
  assert.ok(tokenAttempts > fixture.calls.length)
  assert.equal(patchCalls(fixture.calls).length, 1)
})

test("failed pre-PATCH authentication is retryable and not ambiguous", async () => {
  const fixture = releaseFixture()
  const inspected = await client(fixture.fetch).inspectRelease(RELEASE_ID)
  fixture.calls.length = 0

  const github = client(fixture.fetch, async () => {
    const lastCall = fixture.calls.at(-1)
    if (lastCall && new URL(lastCall.url).pathname.includes("/git/ref/tags/")) {
      throw new Error("auth unavailable")
    }
    return "token"
  })

  await assert.rejects(
    github.publishRelease({
      releaseId: RELEASE_ID,
      expectedVersion: inspected.version,
      latestBehavior: "make_latest",
    }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubApiError)
      assert.equal(error.retryable, true)
      assert.equal(error.ambiguousMutation, false)
      return true
    }
  )
  assert.equal(patchCalls(fixture.calls).length, 0)
})

test("provider failures are redacted and GET retries stay bounded", async (t) => {
  await t.test("rate limit metadata", async () => {
    let calls = 0
    const fetch = (async () => {
      calls++
      return json({ message: "secret provider detail" }, 429, {
        "Retry-After": "9",
        "X-GitHub-Request-Id": "rate-request",
      })
    }) as typeof globalThis.fetch

    await assert.rejects(
      client(fetch).inspectRelease(RELEASE_ID),
      (error: unknown) => {
        assert.ok(error instanceof GitHubApiError)
        assert.equal(error.retryAfterSeconds, 9)
        assert.equal(error.requestId, "rate-request")
        assert.doesNotMatch(error.message, /secret provider detail/)
        return true
      }
    )
    assert.equal(calls, 1)
  })

  await t.test("two GET attempts", async () => {
    let calls = 0
    const fetch = (async () => {
      calls++
      return json({ message: "another secret" }, 503)
    }) as typeof globalThis.fetch

    await assert.rejects(
      client(fetch).inspectRelease(RELEASE_ID),
      (error: unknown) => {
        assert.ok(error instanceof GitHubApiError)
        assert.doesNotMatch(error.message, /another secret/)
        return true
      }
    )
    assert.equal(calls, 2)
  })
})
