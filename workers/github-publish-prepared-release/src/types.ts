export type MakeLatest = "true" | "false" | "legacy"

export type ReleaseAsset = {
  id: number
  name: string
  label: string | null
  sizeBytes: number
  digest: string | null
}

export type ReleaseSnapshot = {
  state: "draft" | "published"
  /**
   * A stable hash of the release content. Publication state and publishedAt
   * are deliberately excluded so an identical retry can be a safe no-op.
   */
  version: string
  repository: string
  repositoryId: number
  releaseId: number
  url: string
  tag: string
  tagCommit: string
  name: string
  body: string
  prerelease: boolean
  assets: ReleaseAsset[]
  publishedAt: string | null
}

export type PublishReleaseInput = {
  releaseId: number
  expectedVersion: string
  makeLatest: MakeLatest
}

export type PublishReleaseResult = {
  snapshot: ReleaseSnapshot
  changed: boolean
  reconciledAfterAmbiguousResponse: boolean
  requestId: string | null
}
