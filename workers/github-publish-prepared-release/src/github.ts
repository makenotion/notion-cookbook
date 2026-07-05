import { createHash } from "node:crypto"

import type { GetAccessToken } from "./auth.js"
import { normalizeRepository } from "./config.js"
import type {
  PublishReleaseInput,
  PublishReleaseResult,
  ReleaseAsset,
  ReleaseSnapshot,
} from "./types.js"

const API_VERSION = "2026-03-10"
const DEFAULT_API_URL = "https://api.github.com"
const MAX_GITHUB_CALLS = 30
const MAX_RELEASE_ASSETS = 100

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
  constructor(
    message: string,
    readonly snapshot: ReleaseSnapshot,
    readonly requestId: string | null
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
  name: string | null
  body: string | null
  draft: boolean
  prerelease: boolean
  published_at: string | null
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

  async inspectRelease(releaseId: number): Promise<ReleaseSnapshot> {
    positiveInteger(releaseId, "releaseId")

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

    const release = await this.get<ReleaseResponse>(
      `/repos/${this.repository}/releases/${releaseId}`
    )
    if (release.id !== releaseId) {
      throw new GitHubPreconditionError("GitHub returned a different release")
    }
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

  async publishRelease(
    input: PublishReleaseInput
  ): Promise<PublishReleaseResult> {
    positiveInteger(input.releaseId, "releaseId")
    if (!/^sha256:[a-f0-9]{64}$/.test(input.expectedVersion)) {
      throw new GitHubPreconditionError(
        "expectedVersion must be the version returned by inspectRelease"
      )
    }
    if (!(["true", "false", "legacy"] as const).includes(input.makeLatest)) {
      throw new GitHubPreconditionError(
        'makeLatest must be "true", "false", or "legacy"'
      )
    }

    // This is intentionally the final work before the write. GitHub does not
    // expose a conditional release-update API, so read-back below also checks
    // for the residual race between this GET and PATCH.
    const before = await this.inspectRelease(input.releaseId)
    if (before.version !== input.expectedVersion) {
      throw new GitHubPreconditionError(
        "GitHub release changed after it was inspected"
      )
    }
    if (before.prerelease && input.makeLatest === "true") {
      throw new GitHubPreconditionError(
        "A prerelease cannot be published as the latest release"
      )
    }
    if (before.state === "published") {
      return {
        snapshot: before,
        changed: false,
        reconciledAfterAmbiguousResponse: false,
        requestId: null,
      }
    }

    let ambiguous = false
    let requestId: string | null = null
    try {
      const response = await this.request<ReleaseResponse>(
        "PATCH",
        `/repos/${this.repository}/releases/${input.releaseId}`,
        { draft: false, make_latest: input.makeLatest },
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
      after = await this.inspectRelease(input.releaseId)
    } catch (error) {
      throw new GitHubApiError(
        "GitHub publication was attempted but exact release read-back failed",
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
      if (after.state === "published") {
        throw new GitHubPublishedPostconditionError(
          "The release is published, but its content changed during publication",
          after,
          requestId
        )
      }
      throw new GitHubApiError(
        "GitHub publication was attempted, but release read-back changed and remained a draft",
        { retryable: true, ambiguousMutation: true, requestId }
      )
    }
    if (after.state !== "published") {
      throw new GitHubApiError(
        "GitHub publication was attempted, but immediate read-back still shows a draft",
        { retryable: true, ambiguousMutation: true, requestId }
      )
    }

    return {
      snapshot: after,
      changed: true,
      reconciledAfterAmbiguousResponse: ambiguous,
      requestId,
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

  private async request<T>(
    method: "GET" | "PATCH",
    path: string,
    body: unknown,
    safeToRetry: boolean
  ): Promise<ApiResponse<T>> {
    const attempts = safeToRetry ? 2 : 1
    for (let attempt = 1; attempt <= attempts; attempt++) {
      this.calls++
      if (this.calls > MAX_GITHUB_CALLS) {
        throw new GitHubPreconditionError(
          `GitHub call budget exceeded ${MAX_GITHUB_CALLS} requests`
        )
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        let token: string
        try {
          token = await this.options.getAccessToken(this.repositoryId)
        } catch {
          if (safeToRetry && attempt < attempts) {
            await this.sleep(100)
            continue
          }
          throw new GitHubApiError(
            "GitHub authentication failed before the API request",
            { retryable: safeToRetry }
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
              ...(body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
              "X-GitHub-Api-Version": API_VERSION,
              "User-Agent": "notion-cookbook-github-release-tools",
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
