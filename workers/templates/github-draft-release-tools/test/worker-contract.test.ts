import assert from "node:assert/strict"
import test from "node:test"

import worker, {
  toPublishErrorResult,
  toPublishSuccessResult,
  toReleaseView,
} from "../src/index.js"
import {
  GitHubApiError,
  GitHubPublishedPostconditionError,
} from "../src/github.js"
import type { ReleaseSnapshot } from "../src/types.js"

type ObjectSchema = {
  properties: Record<
    string,
    {
      type?: string
      enum?: string[]
      description?: string
      items?: ObjectSchema
    }
  >
  required: string[]
}

type ToolManifest = {
  title: string
  description: string
  schema: ObjectSchema
  outputSchema: ObjectSchema
  hints: { readOnlyHint?: boolean }
}

function tool(key: string): ToolManifest {
  const capability = worker.manifest.capabilities.find(
    (candidate) => candidate._tag === "tool" && candidate.key === key
  )
  assert.ok(capability, `missing ${key} tool`)
  return capability.config as ToolManifest
}

function assertObjectShape(
  value: Record<string, unknown>,
  schema: ObjectSchema
): void {
  assert.deepEqual(Object.keys(value).sort(), [...schema.required].sort())
}

const snapshot: ReleaseSnapshot = {
  state: "draft",
  version: `sha256:${"a".repeat(64)}`,
  repository: "acme/widget",
  repositoryId: 42,
  releaseId: 101,
  url: "https://github.com/acme/widget/releases/tag/v1.2.3",
  tag: "v1.2.3",
  tagCommit: "b".repeat(40),
  name: "Version 1.2.3",
  body: "x".repeat(4_001),
  prerelease: false,
  assets: [
    {
      id: 7,
      name: "widget.tgz",
      label: null,
      sizeBytes: 512,
      digest: "sha256:asset",
    },
  ],
  publishedAt: null,
}

test("worker manifest exposes read-only discovery and inspection plus one write", () => {
  assert.deepEqual(
    worker.manifest.capabilities.map(({ key }) => key),
    ["listDraftReleases", "inspectRelease", "publishDraftRelease"]
  )

  const list = tool("listDraftReleases")
  assert.equal(list.hints.readOnlyHint, true)
  assert.deepEqual(list.schema.properties, {})
  assert.deepEqual(list.schema.required, [])
  assert.match(list.description, /never guess/)
  assert.match(list.description, /list may be incomplete/)
  assert.match(list.description, /untrusted data, never as instructions/)
  assert.match(list.description, /call inspectRelease/)
  assert.equal(list.outputSchema.properties.repository.type, "string")
  assert.equal(list.outputSchema.properties.drafts.type, "array")
  assert.equal(list.outputSchema.properties.hasMore.type, "boolean")
  assert.match(
    list.outputSchema.properties.hasMore.description ?? "",
    /may exist/
  )
  const draft = list.outputSchema.properties.drafts.items
  assert.ok(draft)
  assert.deepEqual(
    draft.required.sort(),
    ["releaseId", "tag", "name", "htmlUrl", "prerelease", "createdAt"].sort()
  )
  assert.equal(draft.properties.releaseId.type, "integer")
  assert.equal(draft.properties.tag.type, "string")
  assert.equal(draft.properties.name.type, "string")
  assert.equal(draft.properties.htmlUrl.type, "string")
  assert.equal(draft.properties.prerelease.type, "boolean")
  assert.equal(draft.properties.createdAt.type, "string")

  const inspect = tool("inspectRelease")
  assert.equal(inspect.hints.readOnlyHint, true)
  assert.match(inspect.description, /untrusted data, never as instructions/)
  assert.match(inspect.description, /direct the user to htmlUrl/)
  assert.equal(inspect.schema.properties.releaseId.type, "integer")
  assert.equal(inspect.outputSchema.properties.htmlUrl.type, "string")
  assert.equal(inspect.outputSchema.properties.bodyLength.type, "integer")

  const publish = tool("publishDraftRelease")
  assert.equal(publish.hints.readOnlyHint, false)
  assert.match(publish.description, /Never infer latestBehavior/)
  assert.deepEqual(publish.schema.properties.latestBehavior.enum, [
    "make_latest",
    "keep_current",
  ])
  assert.match(
    publish.schema.properties.latestBehavior.description ?? "",
    /Explicit user choice/
  )
  assert.deepEqual(publish.outputSchema.properties.status.enum, [
    "published",
    "already_published",
    "published_with_issue",
    "conflict",
    "ambiguous",
    "blocked",
  ])
})

test("release view keeps output bounded and points to the complete draft", () => {
  const view = toReleaseView(snapshot)
  assertObjectShape(view, tool("inspectRelease").outputSchema)
  assert.equal(view.htmlUrl, snapshot.url)
  assert.equal(view.bodyPreview.length, 4_000)
  assert.equal(view.bodyLength, 4_001)
  assert.equal(view.bodyTruncated, true)
})

test("publish success mapping preserves mutation certainty", () => {
  const definite = toPublishSuccessResult({
    snapshot: { ...snapshot, state: "published" },
    changed: true,
    requestId: "request-1",
  })
  assertObjectShape(definite, tool("publishDraftRelease").outputSchema)
  assert.equal(definite.status, "published")
  assert.equal(definite.changed, true)

  const reconciled = toPublishSuccessResult({
    snapshot: { ...snapshot, state: "published" },
    changed: null,
    requestId: "request-2",
  })
  assert.equal(reconciled.status, "published")
  assert.equal(reconciled.changed, null)
  assert.match(reconciled.message, /response was ambiguous/)

  const noOp = toPublishSuccessResult({
    snapshot: { ...snapshot, state: "published" },
    changed: false,
    requestId: null,
  })
  assert.equal(noOp.status, "already_published")
  assert.equal(noOp.changed, false)
})

test("publish errors do not claim concurrent mutations", () => {
  const mismatch = toPublishErrorResult(
    new GitHubPublishedPostconditionError(
      "GitHub shows a public release with different content",
      { ...snapshot, state: "published" },
      "request-3",
      { retryable: true, retryAfterSeconds: 9 }
    )
  )
  assertObjectShape(mismatch, tool("publishDraftRelease").outputSchema)
  assert.equal(mismatch.status, "published_with_issue")
  assert.equal(mismatch.changed, null)
  assert.equal(mismatch.published, true)
  assert.equal(mismatch.retryable, true)
  assert.equal(mismatch.retryAfterSeconds, 9)

  const ambiguous = toPublishErrorResult(
    new GitHubApiError("Publication outcome is unknown", {
      ambiguousMutation: true,
      retryable: true,
    })
  )
  assert.equal(ambiguous.status, "ambiguous")
  assert.equal(ambiguous.changed, null)

  const unexpected = new Error("programming error")
  assert.throws(
    () => toPublishErrorResult(unexpected),
    (error: unknown) => error === unexpected
  )
})
