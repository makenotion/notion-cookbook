import { createHash } from "node:crypto"

import type { GetAccessToken } from "./auth.js"
import { normalizeRepository } from "./config.js"
import type {
  DraftReleaseSummary,
  ListDraftReleasesResult,
  PublishReleaseInput,
  PublishReleaseResult,
  ReleaseAsset,
  ReleaseSnapshot,
} from "./types.js"

const API_VERSION = "2026-03-10"
const DEFAULT_API_URL = "https://api.github.com"
const MAX_GITHUB_CALLS = 30
const MAX_DRAFT_RELEASES = 20
const MAX_RELEASE_ASSETS = 100
const MAX_RELEASE_PAGES = 10

type Fetch = typeof globalThis.fetch
type Sleep = (ms: number) => Promise<void>
type Now = () => number

export type GitHubClientOptions = {
  repository: string
  repositoryId: number
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
  readonly retryable: boolean
  readonly retryAfterSeconds: number | null

  constructor(
    message: string,
    readonly snapshot: ReleaseSnapshot,
    readonly requestId: string | null,
    options: {
      retryable?: boolean
      retryAfterSeconds?: number | null
    } = {}
  ) {
    super(message)
    this.name = "GitHubPublishedPostconditionError"
    this.retryable = options.retryable ?? false
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
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
  name: string | null
  body: string | null
  draft: boolean
  prerelease: boolean
  created_at: string
  published_at: string | null
}

type LatestReleaseResponse = { id: number }
type LatestReleaseState = {
  releaseId: number | null
  requestId: string | null
}

type AssetResponse = {
  id: number
  name: string
  label: string | null
  state: string
  size: number
  digest: string | null
}

type GitObject = { type: string; sha: string }
type GitReferenceResponse = { ref: string; object: GitObject }
type GitTagResponse = { object: GitObject }

type ApiResponse<T> = {
  data: T
  headers: Headers
  requestId: string | null
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GitHubPreconditionError(`${name} must be a positive integer`)
  }
  return value
}

function boundedRetryAfterSeconds(value: number): number {
  return Math.max(0, Math.min(3_600, Math.ceil(value)))
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
  return (
    link
      ?.split(",")
      .some((part) => /;\s*rel="[^"]*\bnext\b[^"]*"/.test(part)) ?? false
  )
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

function compareAssets(left: ReleaseAsset, right: ReleaseAsset): number {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1
  return left.id - right.id
}

function releaseVersion(input: {
  repository: string
  repositoryId: number
  releaseId: number
  tag: string
  tagCommit: string
  name: string
  body: string
  prerelease: boolean
  assets: ReleaseAsset[]
}): string {
  // The fixed-order array is the canonical serialization. Publication state
  // and publishedAt are intentionally absent so a retry can observe the same
  // content as published and return a no-op.
  const canonical = JSON.stringify([
    1,
    input.repository,
    input.repositoryId,
    input.releaseId,
    input.tag,
    input.tagCommit,
    input.name,
    input.body,
    input.prerelease,
    input.assets.map((asset) => [
      asset.id,
      asset.name,
      asset.label,
      asset.sizeBytes,
      asset.digest,
    ]),
  ])
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`
}

export class GitHubClient {
  private readonly repository: string
  private readonly repositoryId: number
  private readonly fetch: Fetch
  private readonly sleep: Sleep
  private readonly timeoutMs: number
  private readonly apiBaseUrl: string
  private readonly now: Now
  private calls = 0

  constructor(private readonly options: GitHubClientOptions) {
    this.repository = normalizeRepository(options.repository)
    this.repositoryId = positiveInteger(options.repositoryId, "repositoryId")
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

  async listDraftReleases(): Promise<ListDraftReleasesResult> {
    await this.verifyRepository()

    const drafts: DraftReleaseSummary[] = []
    for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
      const response = await this.getWithHeaders<ReleaseResponse[]>(
        `/repos/${this.repository}/releases?per_page=100&page=${page}`
      )
      for (const release of response.data) {
        if (!release.draft) continue
        drafts.push({
          releaseId: release.id,
          tag: release.tag_name,
          name: release.name ?? "",
          htmlUrl: release.html_url,
          prerelease: release.prerelease,
          createdAt: release.created_at,
        })
        if (drafts.length > MAX_DRAFT_RELEASES) {
          return {
            repository: this.repository,
            drafts: drafts.slice(0, MAX_DRAFT_RELEASES),
            hasMore: true,
          }
        }
      }

      const hasNext = hasNextPage(response.headers.get("Link"))
      if (!hasNext) {
        return { repository: this.repository, drafts, hasMore: false }
      }
    }

    return {
      repository: this.repository,
      drafts,
      hasMore: true,
    }
  }

  async inspectRelease(releaseId: number): Promise<ReleaseSnapshot> {
    positiveInteger(releaseId, "releaseId")
    await this.verifyRepository()

    const listedRelease = await this.findRelease(releaseId)
    // GitHub documents exact-ID reads for public releases only. Drafts come
    // from the authenticated list endpoint; once the list observes a public
    // release, an exact read gives us the freshest supported representation.
    const release = listedRelease.draft
      ? listedRelease
      : await this.get<ReleaseResponse>(
          `/repos/${this.repository}/releases/${releaseId}`
        )
    if (release.id !== releaseId) {
      throw new GitHubPreconditionError("GitHub returned a different release")
    }
    if (!listedRelease.draft && release.draft) {
      throw new GitHubPreconditionError(
        "GitHub release returned to draft state during inspection"
      )
    }
    return this.snapshotRelease(releaseId, release)
  }

  async publishRelease(
    input: PublishReleaseInput
  ): Promise<PublishReleaseResult> {
    positiveInteger(input.releaseId, "releaseId")
    if (!/^sha256:[a-f0-9]{64}$/.test(input.expectedVersion)) {
      throw new GitHubPreconditionError(
        "expectedVersion must be the version returned by inspectRelease"
      )
    }
    if (
      !(["make_latest", "keep_current"] as const).includes(input.latestBehavior)
    ) {
      throw new GitHubPreconditionError(
        'latestBehavior must be "make_latest" or "keep_current"'
      )
    }

    // GitHub does not expose a conditional release-update API. Re-read the
    // release immediately before the write, then verify both release content
    // and latest-release behavior afterward.
    const before = await this.inspectRelease(input.releaseId)
    if (before.version !== input.expectedVersion) {
      throw new GitHubPreconditionError(
        "GitHub release changed after it was inspected"
      )
    }
    if (before.prerelease && input.latestBehavior === "make_latest") {
      throw new GitHubPreconditionError(
        "A prerelease cannot be published as the latest release"
      )
    }
    if (before.state === "published") {
      if (input.latestBehavior === "make_latest") {
        const latest = await this.getLatestRelease()
        if (latest.releaseId !== input.releaseId) {
          throw new GitHubPreconditionError(
            "The release is already published, but it is not GitHub's latest release"
          )
        }
      }
      return {
        snapshot: before,
        changed: false,
        requestId: null,
      }
    }

    const previousLatest =
      input.latestBehavior === "keep_current"
        ? await this.getLatestRelease()
        : null

    let ambiguous = false
    let requestId: string | null = null
    try {
      const response = await this.request<ReleaseResponse>(
        "PATCH",
        `/repos/${this.repository}/releases/${input.releaseId}`,
        {
          draft: false,
          make_latest:
            input.latestBehavior === "make_latest" ? "true" : "false",
        },
        false
      )
      requestId = response.requestId
    } catch (error) {
      if (
        error instanceof GitHubApiError &&
        (error.ambiguousMutation || error.status === 409)
      ) {
        ambiguous = true
        requestId = error.requestId
      } else {
        throw error
      }
    }

    let after: ReleaseSnapshot
    try {
      after = await this.inspectPublishedRelease(input.releaseId)
    } catch (error) {
      throw new GitHubApiError(
        "GitHub publication was attempted but release read-back failed",
        {
          status: error instanceof GitHubApiError ? error.status : null,
          retryable: true,
          retryAfterSeconds:
            error instanceof GitHubApiError ? error.retryAfterSeconds : null,
          ambiguousMutation: true,
          requestId:
            requestId ??
            (error instanceof GitHubApiError ? error.requestId : null),
        }
      )
    }

    if (after.version !== input.expectedVersion) {
      throw new GitHubPublishedPostconditionError(
        "The release is published, but its content changed during publication",
        after,
        requestId
      )
    }

    let latest: LatestReleaseState
    try {
      latest = await this.getLatestRelease()
    } catch (error) {
      throw new GitHubPublishedPostconditionError(
        input.latestBehavior === "make_latest"
          ? "The release is published, but whether GitHub made it latest could not be verified"
          : "The release is published, but whether GitHub kept the previous latest release could not be verified",
        after,
        (error instanceof GitHubApiError ? error.requestId : null) ?? requestId,
        {
          retryable: input.latestBehavior === "make_latest",
          retryAfterSeconds:
            input.latestBehavior === "make_latest" &&
            error instanceof GitHubApiError
              ? error.retryAfterSeconds
              : null,
        }
      )
    }

    const latestMismatch =
      input.latestBehavior === "make_latest"
        ? latest.releaseId !== input.releaseId
        : latest.releaseId !== previousLatest?.releaseId
    if (latestMismatch) {
      throw new GitHubPublishedPostconditionError(
        input.latestBehavior === "make_latest"
          ? "The release is published, but GitHub does not report it as latest"
          : "The release is published, but GitHub's latest release changed during publication",
        after,
        requestId ?? latest.requestId
      )
    }

    return {
      snapshot: after,
      changed: ambiguous ? null : true,
      requestId,
    }
  }

  private async verifyRepository(): Promise<void> {
    // Checking both the configured name and immutable ID prevents a renamed
    // or transferred repository from silently changing the target.
    const repository = await this.get<RepositoryResponse>(
      `/repos/${this.repository}`
    )
    if (
      repository.id !== this.repositoryId ||
      normalizeRepository(repository.full_name) !== this.repository
    ) {
      throw new GitHubPreconditionError(
        "GitHub repository identity does not match GITHUB_REPOSITORY_ID"
      )
    }
    if (repository.archived || repository.disabled) {
      throw new GitHubPreconditionError(
        "GitHub repository is archived or disabled"
      )
    }
  }

  private async inspectPublishedRelease(
    releaseId: number
  ): Promise<ReleaseSnapshot> {
    await this.verifyRepository()
    const release = await this.get<ReleaseResponse>(
      `/repos/${this.repository}/releases/${releaseId}`
    )
    if (release.id !== releaseId) {
      throw new GitHubPreconditionError("GitHub returned a different release")
    }
    if (release.draft || !release.published_at) {
      throw new GitHubPreconditionError(
        "GitHub release is not observably published"
      )
    }
    return this.snapshotRelease(releaseId, release)
  }

  private async snapshotRelease(
    releaseId: number,
    release: ReleaseResponse
  ): Promise<ReleaseSnapshot> {
    if (!release.draft && !release.published_at) {
      throw new GitHubPreconditionError(
        "GitHub release is neither a draft nor observably published"
      )
    }

    const assets = await this.listAssets(releaseId)
    const tagCommit = await this.resolveTagCommit(release)
    const snapshotWithoutVersion = {
      state: release.draft ? ("draft" as const) : ("published" as const),
      repository: this.repository,
      repositoryId: this.repositoryId,
      releaseId,
      url: release.html_url,
      tag: release.tag_name,
      tagCommit,
      name: release.name ?? "",
      body: release.body ?? "",
      prerelease: release.prerelease,
      assets,
      publishedAt: release.published_at,
    }
    return {
      ...snapshotWithoutVersion,
      version: releaseVersion(snapshotWithoutVersion),
    }
  }

  private async listAssets(releaseId: number): Promise<ReleaseAsset[]> {
    const response = await this.getWithHeaders<AssetResponse[]>(
      `/repos/${this.repository}/releases/${releaseId}/assets?per_page=${MAX_RELEASE_ASSETS}&page=1`
    )
    if (
      response.data.length > MAX_RELEASE_ASSETS ||
      hasNextPage(response.headers.get("Link"))
    ) {
      throw new GitHubPreconditionError(
        `Release has more than ${MAX_RELEASE_ASSETS} assets`
      )
    }
    if (response.data.some((asset) => asset.state !== "uploaded")) {
      throw new GitHubPreconditionError(
        "Release has an asset that has not finished uploading"
      )
    }

    const assets = response.data.map((asset) => ({
      id: asset.id,
      name: asset.name,
      label: asset.label ?? null,
      sizeBytes: asset.size,
      digest: asset.digest ?? null,
    }))
    assets.sort(compareAssets)
    return assets
  }

  private async findRelease(releaseId: number): Promise<ReleaseResponse> {
    for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
      const response = await this.getWithHeaders<ReleaseResponse[]>(
        `/repos/${this.repository}/releases?per_page=100&page=${page}`
      )
      const release = response.data.find(
        (candidate) => candidate.id === releaseId
      )
      if (release) return release

      const hasNext = hasNextPage(response.headers.get("Link"))
      if (!hasNext) {
        throw new GitHubPreconditionError(
          "GitHub release was not found in the configured repository"
        )
      }
    }

    throw new GitHubPreconditionError(
      `Release lookup exceeded the most recent ${MAX_RELEASE_PAGES * 100} releases`
    )
  }

  private async getLatestRelease(): Promise<LatestReleaseState> {
    try {
      const response = await this.getWithHeaders<LatestReleaseResponse>(
        `/repos/${this.repository}/releases/latest`
      )
      return {
        releaseId: positiveInteger(
          response.data.id,
          "GitHub latest release ID"
        ),
        requestId: response.requestId,
      }
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        return { releaseId: null, requestId: error.requestId }
      }
      throw error
    }
  }

  private async resolveTagCommit(release: ReleaseResponse): Promise<string> {
    let object: GitObject
    try {
      const ref = await this.get<GitReferenceResponse>(
        `/repos/${this.repository}/git/ref/tags/${encodePath(release.tag_name)}`
      )
      if (ref.ref !== `refs/tags/${release.tag_name}`) {
        throw new GitHubPreconditionError(
          "GitHub returned a different tag reference"
        )
      }
      object = ref.object
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        throw new GitHubPreconditionError(
          "Release tag must exist before publication"
        )
      }
      throw error
    }

    for (let depth = 0; depth <= 3; depth++) {
      if (object.type === "commit") return object.sha
      if (object.type !== "tag" || depth === 3) {
        throw new GitHubPreconditionError(
          "Release tag does not resolve to a commit"
        )
      }
      const annotated = await this.get<GitTagResponse>(
        `/repos/${this.repository}/git/tags/${object.sha}`
      )
      object = annotated.object
    }
    throw new GitHubPreconditionError(
      "Release tag does not resolve to a commit"
    )
  }

  private async get<T>(path: string): Promise<T> {
    return (await this.getWithHeaders<T>(path)).data
  }

  private getWithHeaders<T>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>("GET", path, undefined, true)
  }

  private async accessToken(): Promise<string> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const token = await this.options.getAccessToken(this.repositoryId)
        if (!token.trim()) throw new Error("empty token")
        return token
      } catch {
        if (attempt < 2) {
          await this.sleep(100)
          continue
        }
      }
    }

    throw new GitHubApiError(
      "GitHub authentication failed before the API request",
      { retryable: true }
    )
  }

  private async request<T>(
    method: "GET" | "PATCH",
    path: string,
    body: unknown,
    safeToRetry: boolean
  ): Promise<ApiResponse<T>> {
    const attempts = safeToRetry ? 2 : 1
    for (let attempt = 1; attempt <= attempts; attempt++) {
      // Authentication happens before the provider request, so it is always
      // safe to retry even when the eventual request is a non-retried PATCH.
      const token = await this.accessToken()

      this.calls++
      if (this.calls > MAX_GITHUB_CALLS) {
        throw new GitHubPreconditionError(
          `GitHub call budget exceeded ${MAX_GITHUB_CALLS} requests`
        )
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        let response: Response
        try {
          response = await this.fetch(`${this.apiBaseUrl}${path}`, {
            method,
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              ...(body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
              "X-GitHub-Api-Version": API_VERSION,
              "User-Agent": "notion-cookbook-github-draft-release-tools",
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
          try {
            return {
              data: (await response.json()) as T,
              headers: response.headers,
              requestId,
            }
          } catch (error) {
            if (safeToRetry && attempt < attempts) {
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
        }

        // Provider text is inspected only for GitHub's secondary-rate-limit
        // marker and is never included in an error or tool result.
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
        const retryable = isRateLimit || response.status >= 500

        if (safeToRetry && retryable && attempt < attempts) {
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
            retryable,
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
