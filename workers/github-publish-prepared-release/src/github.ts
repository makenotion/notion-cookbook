import type { GetAccessToken } from "./auth.js"
import {
  boundedRetryAfterSeconds,
  normalizeRepository,
  sha256,
} from "./policy.js"
import type {
  PublishPreparedReleaseInput,
  ReleaseRecord,
  RequiredCheck,
} from "./types.js"

const API_VERSION = "2026-03-10"
const DEFAULT_API_URL = "https://api.github.com"
const MAX_GITHUB_CALLS = 50
const MAX_ASSET_PAGES = 2
const MAX_GATE_PAGES = 3

type Fetch = typeof globalThis.fetch
type Sleep = (ms: number) => Promise<void>
type Now = () => number

export type GitHubClientOptions = {
  getAccessToken: GetAccessToken
  fetch?: Fetch
  sleep?: Sleep
  now?: Now
  requestTimeoutMs?: number
  apiBaseUrl?: string
}

export class GitHubApiError extends Error {
  readonly status: number | null
  readonly retryable: boolean
  readonly retryAfterSeconds: number | null
  readonly ambiguousMutation: boolean
  readonly requestId: string | null

  constructor(
    message: string,
    options: {
      status?: number | null
      retryable?: boolean
      retryAfterSeconds?: number | null
      ambiguousMutation?: boolean
      requestId?: string | null
    } = {}
  ) {
    super(message)
    this.name = "GitHubApiError"
    this.status = options.status ?? null
    this.retryable = options.retryable ?? false
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
    this.ambiguousMutation = options.ambiguousMutation ?? false
    this.requestId = options.requestId ?? null
  }
}

export class GitHubPreconditionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GitHubPreconditionError"
  }
}

export class GitHubPublishedPostconditionError extends Error {
  constructor(
    message: string,
    readonly record: ReleaseRecord,
    readonly retryable: boolean,
    readonly retryAfterSeconds: number | null = null
  ) {
    super(message)
    this.name = "GitHubPublishedPostconditionError"
  }
}

type RepositoryResponse = {
  id: number
  full_name: string
  archived: boolean
  disabled: boolean
}

type ReleaseResponse = {
  id: number
  html_url: string
  tag_name: string
  target_commitish: string
  name: string | null
  body: string | null
  draft: boolean
  prerelease: boolean
  published_at: string | null
}

type AssetResponse = {
  id: number
  name: string
  size: number
  digest: string | null
}

type CheckRunResponse = {
  id: number
  name: string
  status: string
  conclusion: string | null
  app: { id: number } | null
}

type CheckRunsResponse = {
  check_runs: CheckRunResponse[]
}

type GitReferenceResponse = {
  ref: string
  object: { type: string; sha: string }
}

type GitTagResponse = {
  object: { type: string; sha: string }
}

type CommitResponse = { sha: string }

export type VerifiedRelease = {
  state: "draft" | "published"
  record: ReleaseRecord
}

export type PublishResult = {
  release: VerifiedRelease
  reconciledAfterAmbiguousResponse: boolean
}

function retryAfterSeconds(response: Response, now: number): number | null {
  const value = response.headers.get("Retry-After")
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return boundedRetryAfterSeconds(seconds)
  }
  const date = Date.parse(value)
  if (Number.isNaN(date)) return null
  return boundedRetryAfterSeconds((date - now) / 1_000)
}

function rateLimitResetSeconds(response: Response, now: number): number | null {
  if (response.headers.get("X-RateLimit-Remaining") !== "0") return null
  const value = response.headers.get("X-RateLimit-Reset")
  if (!value) return null
  const reset = Number(value)
  if (!Number.isFinite(reset) || reset < 0) return null
  return boundedRetryAfterSeconds(reset - now / 1_000)
}

function rateLimitMessage(status: number, delay: number | null): string {
  return `GitHub request is rate limited (HTTP ${status})${
    delay === null ? "" : `; retry after ${delay} seconds`
  }`
}

function hasNextPage(link: string | null): boolean {
  if (!link) return false
  return link
    .split(",")
    .some((part) => /;\s*rel="[^"]*\bnext\b[^"]*"/.test(part))
}

function encodePath(value: string): string {
  return encodeURIComponent(value)
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || /aborted|timeout/i.test(error.message))
  )
}

function sameReleaseRecord(left: ReleaseRecord, right: ReleaseRecord): boolean {
  return (
    left.releaseId === right.releaseId &&
    left.repositoryId === right.repositoryId &&
    left.repository === right.repository &&
    left.tag === right.tag &&
    left.targetCommit === right.targetCommit &&
    left.url === right.url &&
    left.nameSha256 === right.nameSha256 &&
    left.bodySha256 === right.bodySha256 &&
    left.prerelease === right.prerelease &&
    left.publishedAt === right.publishedAt
  )
}

export class GitHubClient {
  private readonly fetch: Fetch
  private readonly sleep: Sleep
  private readonly timeoutMs: number
  private readonly apiBaseUrl: string
  private readonly now: Now
  private calls = 0

  constructor(private readonly options: GitHubClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.timeoutMs = options.requestTimeoutMs ?? 8_000
    this.apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_URL).replace(/\/$/, "")
    this.now = options.now ?? Date.now
  }

  get callCount(): number {
    return this.calls
  }

  async verifyPreparedRelease(
    input: PublishPreparedReleaseInput,
    expectedRepositoryId: number,
    options: {
      verifyGates: boolean
      verifyLatest?: boolean
      expectedPublishedRecord?: ReleaseRecord | null
    } = { verifyGates: true }
  ): Promise<VerifiedRelease> {
    const repository = normalizeRepository(input.repository)
    // Immutable repository identity is deliberately the first provider read.
    const repo = await this.get<RepositoryResponse>(
      `/repos/${repository}`,
      expectedRepositoryId
    )
    if (
      repo.id !== expectedRepositoryId ||
      normalizeRepository(repo.full_name) !== repository
    ) {
      throw new GitHubPreconditionError(
        "GitHub repository identity does not match the configured numeric allowlist"
      )
    }
    if (repo.archived || repo.disabled) {
      throw new GitHubPreconditionError(
        "GitHub repository is archived or disabled"
      )
    }

    const release = await this.get<ReleaseResponse>(
      `/repos/${repository}/releases/${input.releaseId}`,
      expectedRepositoryId
    )
    if (release.id !== input.releaseId) {
      throw new GitHubPreconditionError(
        "GitHub returned a different release ID"
      )
    }
    const published =
      release.draft === false &&
      typeof release.published_at === "string" &&
      release.published_at.length > 0
    if (!release.draft && !published) {
      throw new GitHubPreconditionError(
        "Release is neither a draft nor observably published"
      )
    }
    const observedRecord: ReleaseRecord = {
      releaseId: release.id,
      repositoryId: repo.id,
      repository,
      tag: release.tag_name,
      targetCommit: input.targetCommit,
      url: release.html_url,
      nameSha256: sha256(release.name ?? ""),
      bodySha256: sha256(release.body ?? ""),
      prerelease: release.prerelease,
      publishedAt: release.published_at ?? "",
    }
    try {
      if (release.tag_name !== input.tag) {
        throw new GitHubPreconditionError(
          "Draft release tag no longer matches approval"
        )
      }
      if (release.prerelease !== input.prerelease) {
        throw new GitHubPreconditionError(
          "Draft release prerelease setting no longer matches approval"
        )
      }
      if (sha256(release.name ?? "") !== input.nameSha256) {
        throw new GitHubPreconditionError(
          "Draft release name hash no longer matches approval"
        )
      }
      if (sha256(release.body ?? "") !== input.bodySha256) {
        throw new GitHubPreconditionError(
          "Draft release body hash no longer matches approval"
        )
      }

      const assets = await this.listAssets(
        repository,
        input.releaseId,
        expectedRepositoryId
      )
      this.verifyAssets(assets, input)

      const tagCommit = await this.resolveTagCommit(
        repository,
        input.tag,
        expectedRepositoryId
      )
      if (tagCommit !== input.targetCommit) {
        throw new GitHubPreconditionError(
          "Tag ref no longer resolves to the approved commit"
        )
      }

      // target_commitish is a pre-publication branch/ref gate. Once GitHub has
      // published the exact release, that branch may advance and is no longer a
      // stable receipt-resume checkpoint.
      if (!published) {
        const target = await this.get<CommitResponse>(
          `/repos/${repository}/commits/${encodePath(release.target_commitish)}`,
          expectedRepositoryId
        )
        if (target.sha !== input.targetCommit) {
          throw new GitHubPreconditionError(
            "Release target_commitish no longer resolves to the approved commit"
          )
        }
      }
      const commit = await this.get<CommitResponse>(
        `/repos/${repository}/commits/${input.targetCommit}`,
        expectedRepositoryId
      )
      if (commit.sha !== input.targetCommit) {
        throw new GitHubPreconditionError(
          "Approved target commit is not canonical"
        )
      }

      if (options.verifyGates) {
        await this.verifyChecks(
          repository,
          input.targetCommit,
          input.requiredChecks,
          expectedRepositoryId
        )
      }

      const verified: VerifiedRelease = {
        state: published ? "published" : "draft",
        record: observedRecord,
      }
      if (options.expectedPublishedRecord) {
        if (
          !published ||
          !sameReleaseRecord(verified.record, options.expectedPublishedRecord)
        ) {
          throw new GitHubPreconditionError(
            "Published release no longer matches the durable checkpoint"
          )
        }
      }
      if (
        published &&
        input.makeLatest === "true" &&
        options.verifyLatest !== false
      ) {
        let latest: ReleaseResponse
        try {
          latest = await this.get<ReleaseResponse>(
            `/repos/${repository}/releases/latest`,
            expectedRepositoryId
          )
        } catch (error) {
          throw new GitHubPublishedPostconditionError(
            "Release is published, but the observable latest-release read is unavailable",
            verified.record,
            error instanceof GitHubApiError && error.retryable,
            error instanceof GitHubApiError ? error.retryAfterSeconds : null
          )
        }
        if (latest.id !== input.releaseId) {
          throw new GitHubPublishedPostconditionError(
            "Release is published but is not the repository's observable latest release",
            verified.record,
            true
          )
        }
      }
      return verified
    } catch (error) {
      if (published && !(error instanceof GitHubPublishedPostconditionError)) {
        throw new GitHubPublishedPostconditionError(
          `The exact release is published, but its approved checkpoint could not be verified: ${
            error instanceof GitHubPreconditionError
              ? error.message
              : "a required provider read was unavailable"
          }`,
          observedRecord,
          error instanceof GitHubApiError && error.retryable,
          error instanceof GitHubApiError ? error.retryAfterSeconds : null
        )
      }
      throw error
    }
  }

  async publishAndReconcile(
    input: PublishPreparedReleaseInput,
    expectedRepositoryId: number
  ): Promise<PublishResult> {
    const repository = normalizeRepository(input.repository)
    let ambiguous = false
    try {
      await this.request<ReleaseResponse>(
        "PATCH",
        `/repos/${repository}/releases/${input.releaseId}`,
        { draft: false, make_latest: input.makeLatest },
        false,
        expectedRepositoryId
      )
    } catch (error) {
      if (
        error instanceof GitHubApiError &&
        (error.ambiguousMutation || error.status === 409)
      ) {
        ambiguous = true
      } else {
        throw error
      }
    }

    // A success response, timeout, retryable 5xx, and 409 are all reconciled by
    // exact release ID. PATCH is never retried.
    let release: VerifiedRelease
    try {
      release = await this.verifyPreparedRelease(input, expectedRepositoryId, {
        verifyGates: false,
        verifyLatest: true,
      })
    } catch (error) {
      if (error instanceof GitHubPublishedPostconditionError) throw error
      if (error instanceof GitHubApiError) {
        throw new GitHubApiError(
          "GitHub publication was attempted but terminal read-back was unavailable",
          {
            status: error.status,
            retryable: true,
            retryAfterSeconds: error.retryAfterSeconds,
            ambiguousMutation: true,
            requestId: error.requestId,
          }
        )
      }
      // PATCH has already been sent. A content/tag/asset checkpoint failure is
      // not a pre-write conflict: minimally observe the exact release ID so the
      // caller is never told that a possibly public release is still private.
      try {
        const observed = await this.observeExactRelease(
          input,
          expectedRepositoryId
        )
        if (observed.state === "published") {
          throw new GitHubPublishedPostconditionError(
            "The exact release is published, but its post-publication checkpoint drifted",
            observed.record,
            false
          )
        }
      } catch (observationError) {
        if (observationError instanceof GitHubPublishedPostconditionError) {
          throw observationError
        }
      }
      throw new GitHubApiError(
        "GitHub publication was attempted but exact-release reconciliation remained inconclusive",
        { retryable: true, ambiguousMutation: true }
      )
    }
    if (release.state !== "published") {
      throw new GitHubApiError(
        ambiguous
          ? "GitHub publication response was ambiguous and read-back still shows a draft"
          : "GitHub acknowledged publication but immediate read-back still shows a draft",
        { retryable: true, ambiguousMutation: true }
      )
    }
    return { release, reconciledAfterAmbiguousResponse: ambiguous }
  }

  private async listAssets(
    repository: string,
    releaseId: number,
    repositoryId: number
  ): Promise<AssetResponse[]> {
    const assets: AssetResponse[] = []
    for (let page = 1; page <= MAX_ASSET_PAGES; page++) {
      const response = await this.getWithHeaders<AssetResponse[]>(
        `/repos/${repository}/releases/${releaseId}/assets?per_page=100&page=${page}`,
        repositoryId
      )
      assets.push(...response.data)
      if (assets.length > 100) {
        throw new GitHubPreconditionError(
          "Release has more than the supported 100 assets"
        )
      }
      if (!hasNextPage(response.headers.get("Link"))) return assets
    }
    throw new GitHubPreconditionError(
      "Release asset pagination exceeded its limit"
    )
  }

  private verifyAssets(
    assets: AssetResponse[],
    input: PublishPreparedReleaseInput
  ): void {
    if (assets.length !== input.requiredAssets.length) {
      throw new GitHubPreconditionError(
        "Release asset manifest count no longer matches approval"
      )
    }
    const observed = new Map(assets.map((asset) => [asset.name, asset]))
    if (observed.size !== assets.length) {
      throw new GitHubPreconditionError(
        "Release contains duplicate asset names"
      )
    }
    for (const expected of input.requiredAssets) {
      const asset = observed.get(expected.name)
      if (
        !asset ||
        asset.size !== expected.sizeBytes ||
        asset.digest !== `sha256:${expected.sha256}`
      ) {
        throw new GitHubPreconditionError(
          `Release asset manifest mismatch for ${expected.name}`
        )
      }
    }
  }

  private async resolveTagCommit(
    repository: string,
    tag: string,
    repositoryId: number
  ): Promise<string> {
    const ref = await this.get<GitReferenceResponse>(
      `/repos/${repository}/git/ref/tags/${encodePath(tag)}`,
      repositoryId
    )
    if (ref.ref !== `refs/tags/${tag}`) {
      throw new GitHubPreconditionError("GitHub returned a different tag ref")
    }
    let object = ref.object
    for (let depth = 0; depth <= 3; depth++) {
      if (object.type === "commit") return object.sha
      if (object.type !== "tag" || depth === 3) {
        throw new GitHubPreconditionError(
          "Tag does not resolve to a commit within three annotated-tag dereferences"
        )
      }
      const annotated = await this.get<GitTagResponse>(
        `/repos/${repository}/git/tags/${object.sha}`,
        repositoryId
      )
      object = annotated.object
    }
    throw new GitHubPreconditionError("Tag did not resolve to a commit")
  }

  private async verifyChecks(
    repository: string,
    sha: string,
    required: RequiredCheck[],
    repositoryId: number
  ): Promise<void> {
    const runs = await this.listCheckRuns(repository, sha, repositoryId)

    for (const gate of required) {
      const matches = runs.filter(
        (run) => run.name === gate.name && run.app?.id === gate.appId
      )
      if (
        matches.length < 1 ||
        matches.some(
          (run) => run.status !== "completed" || run.conclusion !== "success"
        )
      ) {
        throw new GitHubPreconditionError(
          `Required check-run is not successful: ${gate.name}`
        )
      }
    }
  }

  private async listCheckRuns(
    repository: string,
    sha: string,
    repositoryId: number
  ): Promise<CheckRunResponse[]> {
    const all: CheckRunResponse[] = []
    for (let page = 1; page <= MAX_GATE_PAGES; page++) {
      const response = await this.getWithHeaders<CheckRunsResponse>(
        `/repos/${repository}/commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`,
        repositoryId
      )
      all.push(...response.data.check_runs)
      if (!hasNextPage(response.headers.get("Link"))) return all
    }
    throw new GitHubPreconditionError(
      "Check-run pagination exceeded 300 records"
    )
  }

  private async observeExactRelease(
    input: PublishPreparedReleaseInput,
    expectedRepositoryId: number
  ): Promise<VerifiedRelease> {
    const repository = normalizeRepository(input.repository)
    const repo = await this.get<RepositoryResponse>(
      `/repos/${repository}`,
      expectedRepositoryId
    )
    if (
      repo.id !== expectedRepositoryId ||
      normalizeRepository(repo.full_name) !== repository
    ) {
      throw new GitHubPreconditionError(
        "GitHub repository identity does not match the configured numeric allowlist"
      )
    }
    const release = await this.get<ReleaseResponse>(
      `/repos/${repository}/releases/${input.releaseId}`,
      expectedRepositoryId
    )
    if (release.id !== input.releaseId) {
      throw new GitHubPreconditionError(
        "GitHub returned a different release ID"
      )
    }
    const published = release.draft === false && release.published_at !== null
    return {
      state: published ? "published" : "draft",
      record: {
        releaseId: release.id,
        repositoryId: repo.id,
        repository,
        tag: release.tag_name,
        targetCommit: input.targetCommit,
        url: release.html_url,
        nameSha256: sha256(release.name ?? ""),
        bodySha256: sha256(release.body ?? ""),
        prerelease: release.prerelease,
        publishedAt: release.published_at ?? "",
      },
    }
  }

  private async get<T>(path: string, repositoryId: number): Promise<T> {
    return (await this.getWithHeaders<T>(path, repositoryId)).data
  }

  private getWithHeaders<T>(
    path: string,
    repositoryId: number
  ): Promise<{ data: T; headers: Headers }> {
    return this.request<T>("GET", path, undefined, true, repositoryId)
  }

  private async request<T>(
    method: "GET" | "PATCH",
    path: string,
    body: unknown,
    safeToRetry: boolean,
    repositoryId: number
  ): Promise<{ data: T; headers: Headers }> {
    const attempts = safeToRetry ? 2 : 1
    for (let attempt = 1; attempt <= attempts; attempt++) {
      this.calls++
      if (this.calls > MAX_GITHUB_CALLS) {
        throw new GitHubPreconditionError(
          "GitHub call budget exceeded 50 requests"
        )
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        let token: string
        try {
          token = await this.options.getAccessToken(repositoryId)
        } catch {
          if (safeToRetry && attempt < attempts) {
            await this.sleep(100)
            continue
          }
          throw new GitHubApiError(
            "GitHub authentication failed before the API request",
            { retryable: true, ambiguousMutation: false }
          )
        }

        let response: Response
        try {
          response = await this.fetch(`${this.apiBaseUrl}${path}`, {
            method,
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "Content-Type": "application/json",
              "X-GitHub-Api-Version": API_VERSION,
              "User-Agent": "notion-cookbook-github-publish-prepared-release",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          })
        } catch (error) {
          if (safeToRetry && attempt < attempts) {
            await this.sleep(100)
            continue
          }
          throw new GitHubApiError(
            isAbort(error)
              ? `GitHub request timed out after ${this.timeoutMs}ms`
              : "GitHub request failed before a response",
            {
              retryable: true,
              ambiguousMutation: method === "PATCH",
            }
          )
        }

        const requestId = response.headers.get("X-GitHub-Request-Id")
        if (response.ok) {
          let data: T
          try {
            data = (await response.json()) as T
          } catch (error) {
            if (safeToRetry && isAbort(error) && attempt < attempts) {
              await this.sleep(100)
              continue
            }
            throw new GitHubApiError(
              isAbort(error)
                ? `GitHub response body timed out after ${this.timeoutMs}ms`
                : "GitHub returned invalid JSON",
              {
                status: response.status,
                retryable: safeToRetry,
                ambiguousMutation: method === "PATCH",
                requestId,
              }
            )
          }
          return { data, headers: response.headers }
        }

        // Inspect only for GitHub's documented secondary-limit marker. Never
        // surface provider response text; it can contain secrets,
        // attacker-controlled content, or confusing instructions. The same
        // timer remains active until this body has been consumed.
        let responseText: string
        try {
          responseText = await response.text()
        } catch (error) {
          if (safeToRetry && attempt < attempts) {
            await this.sleep(100)
            continue
          }
          throw new GitHubApiError(
            isAbort(error)
              ? `GitHub response body timed out after ${this.timeoutMs}ms`
              : "GitHub response body could not be consumed",
            {
              status: response.status,
              retryable: true,
              ambiguousMutation: method === "PATCH",
              requestId,
            }
          )
        }

        const isRateLimit =
          response.status === 429 ||
          (response.status === 403 &&
            (response.headers.has("Retry-After") ||
              response.headers.get("X-RateLimit-Remaining") === "0" ||
              /secondary rate limit|abuse detection/i.test(responseText)))
        const now = this.now()
        const retryAfter =
          retryAfterSeconds(response, now) ??
          rateLimitResetSeconds(response, now) ??
          (isRateLimit ? 60 : null)
        const retryableStatus = isRateLimit || response.status >= 500
        if (safeToRetry && retryableStatus && attempt < attempts) {
          if (retryAfter !== null && retryAfter > 2) {
            throw new GitHubApiError(
              rateLimitMessage(response.status, retryAfter),
              {
                status: response.status,
                retryable: true,
                retryAfterSeconds: retryAfter,
                requestId,
              }
            )
          }
          await this.sleep((retryAfter ?? 0.1) * 1_000)
          continue
        }

        throw new GitHubApiError(
          isRateLimit
            ? rateLimitMessage(response.status, retryAfter)
            : `GitHub rejected the request (HTTP ${response.status})`,
          {
            status: response.status,
            retryable: retryableStatus,
            retryAfterSeconds: retryAfter,
            ambiguousMutation:
              method === "PATCH" &&
              (response.status === 409 || response.status >= 500),
            requestId,
          }
        )
      } finally {
        clearTimeout(timer)
      }
    }
    throw new GitHubApiError("GitHub request exhausted its retry budget", {
      retryable: true,
    })
  }
}
