export type LatestBehavior = "make_latest" | "keep_current"

export type DraftReleaseSummary = {
  releaseId: number
  tag: string
  name: string
  htmlUrl: string
  prerelease: boolean
  createdAt: string
}

export type ListDraftReleasesResult = {
  repository: string
  drafts: DraftReleaseSummary[]
  hasMore: boolean
}

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
  latestBehavior: LatestBehavior
}

export type PublishReleaseResult = {
  snapshot: ReleaseSnapshot
  changed: boolean | null
  requestId: string | null
}
