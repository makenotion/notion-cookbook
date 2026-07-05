import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"

import { createGitHubAccessTokenProvider } from "./auth.js"
import { loadConfig } from "./config.js"
import {
  GitHubApiError,
  GitHubClient,
  GitHubPreconditionError,
  GitHubPublishedPostconditionError,
} from "./github.js"
import type { MakeLatest, ReleaseSnapshot } from "./types.js"

const BODY_PREVIEW_CHARS = 4_000

const worker = new Worker()
export default worker

const getAccessToken = createGitHubAccessTokenProvider()

function githubClient(): GitHubClient {
  const config = loadConfig()
  return new GitHubClient({
    repository: config.repository,
    repositoryId: config.repositoryId,
    getAccessToken,
    requestTimeoutMs: config.githubRequestTimeoutMs,
  })
}

function releaseView(snapshot: ReleaseSnapshot) {
  return {
    repository: snapshot.repository,
    releaseId: snapshot.releaseId,
    state: snapshot.state,
    version: snapshot.version,
    url: snapshot.url,
    tag: snapshot.tag,
    tagCommit: snapshot.tagCommit,
    name: snapshot.name,
    bodyPreview: snapshot.body.slice(0, BODY_PREVIEW_CHARS),
    bodyTruncated: snapshot.body.length > BODY_PREVIEW_CHARS,
    prerelease: snapshot.prerelease,
    publishedAt: snapshot.publishedAt,
    assetCount: snapshot.assets.length,
    assets: snapshot.assets,
  }
}

const assetSchema = j.object({
  id: j.integer().describe("GitHub's numeric asset ID."),
  name: j.string().describe("Release asset filename."),
  label: j.string().nullable().describe("Optional release asset label."),
  sizeBytes: j.integer().describe("Asset size in bytes."),
  digest: j
    .string()
    .nullable()
    .describe("Provider-reported asset digest when GitHub supplies one."),
})

const releaseViewSchema = j.object({
  repository: j.string().describe("Configured GitHub owner and repository."),
  releaseId: j.integer().describe("GitHub's numeric release ID."),
  state: j.enum("draft", "published").describe("Current release state."),
  version: j
    .string()
    .describe("Opaque content version to pass to publishDraftRelease."),
  url: j.string().describe("GitHub release URL."),
  tag: j.string().describe("Release tag name."),
  tagCommit: j.string().describe("Full commit SHA resolved from the tag."),
  name: j.string().describe("Current release title."),
  bodyPreview: j
    .string()
    .describe("First 4,000 characters of the release notes."),
  bodyTruncated: j
    .boolean()
    .describe("Whether the release notes exceed the returned preview."),
  prerelease: j
    .boolean()
    .describe("Whether GitHub marks this as a prerelease."),
  publishedAt: j
    .string()
    .nullable()
    .describe("GitHub publication time, or null while this is a draft."),
  assetCount: j.integer().describe("Number of attached release assets."),
  assets: j.array(assetSchema).describe("Complete bounded asset manifest."),
})

const publishResultSchema = j.object({
  ok: j.boolean().describe("Whether publication completed as requested."),
  status: j
    .enum(
      "published",
      "already_published",
      "published_with_drift",
      "conflict",
      "ambiguous",
      "blocked"
    )
    .describe("Observed terminal result."),
  changed: j
    .boolean()
    .nullable()
    .describe("Whether this call published the release, or null if unknown."),
  published: j
    .boolean()
    .nullable()
    .describe(
      "Observed publication state, or null when it could not be proven."
    ),
  release: releaseViewSchema
    .nullable()
    .describe("Observed release when a trustworthy read is available."),
  message: j.string().describe("Concise result and safe next action."),
  retryable: j.boolean().describe("Whether a later inspection may be useful."),
  retryAfterSeconds: j
    .integer()
    .nullable()
    .describe("Provider retry delay when supplied."),
  requestId: j
    .string()
    .nullable()
    .describe("GitHub request ID for provider support."),
})

worker.tool("inspectDraftRelease", {
  title: "Inspect GitHub draft release",
  description:
    "Inspect one release in the configured GitHub repository before publishing it. Returns the live tag, commit, notes preview, assets, and an opaque version for publishDraftRelease.",
  schema: j.object({
    releaseId: j.integer().describe("Numeric GitHub release ID to inspect."),
  }),
  outputSchema: releaseViewSchema,
  hints: { readOnlyHint: true },
  execute: async ({ releaseId }) =>
    releaseView(await githubClient().inspectRelease(releaseId)),
})

worker.tool("publishDraftRelease", {
  title: "Publish GitHub draft release",
  description:
    "Publish the exact release version returned by inspectDraftRelease after the user asks to make it public. Re-checks GitHub immediately before one publication request and then reads the release back.",
  schema: j.object({
    releaseId: j
      .integer()
      .describe("Numeric GitHub release ID returned by inspection."),
    expectedVersion: j
      .string()
      .describe("Exact opaque version returned by inspectDraftRelease."),
    makeLatest: j
      .enum("true", "false", "legacy")
      .describe("GitHub policy for selecting the repository's latest release."),
  }),
  outputSchema: publishResultSchema,
  hints: { readOnlyHint: false },
  execute: async ({ releaseId, expectedVersion, makeLatest }) => {
    const client = githubClient()
    try {
      const result = await client.publishRelease({
        releaseId,
        expectedVersion,
        makeLatest: makeLatest as MakeLatest,
      })
      return {
        ok: true,
        status: result.changed
          ? ("published" as const)
          : ("already_published" as const),
        changed: result.changed,
        published: true,
        release: releaseView(result.snapshot),
        message: result.changed
          ? result.reconciledAfterAmbiguousResponse
            ? "GitHub published the release; read-back confirmed an ambiguous response."
            : "GitHub published the inspected release."
          : "This exact release version is already published; no update was sent.",
        retryable: false,
        retryAfterSeconds: null,
        requestId: result.requestId,
      }
    } catch (error) {
      if (error instanceof GitHubPublishedPostconditionError) {
        return {
          ok: false,
          status: "published_with_drift" as const,
          changed: true,
          published: true,
          release: releaseView(error.snapshot),
          message: error.message,
          retryable: false,
          retryAfterSeconds: null,
          requestId: error.requestId,
        }
      }
      if (error instanceof GitHubPreconditionError) {
        return {
          ok: false,
          status: "conflict" as const,
          changed: false,
          published: null,
          release: null,
          message: error.message,
          retryable: false,
          retryAfterSeconds: null,
          requestId: null,
        }
      }
      if (error instanceof GitHubApiError) {
        return {
          ok: false,
          status: error.ambiguousMutation
            ? ("ambiguous" as const)
            : ("blocked" as const),
          changed: error.ambiguousMutation ? null : false,
          published: null,
          release: null,
          message: error.message,
          retryable: error.retryable,
          retryAfterSeconds: error.retryAfterSeconds,
          requestId: error.requestId,
        }
      }
      return {
        ok: false,
        status: "blocked" as const,
        changed: false,
        published: null,
        release: null,
        message:
          "Release publication failed without exposing provider details.",
        retryable: false,
        retryAfterSeconds: null,
        requestId: null,
      }
    }
  },
})
