import { canonicalPacket, sha256 } from "../src/policy.js"
import type {
  PublishPreparedReleaseInput,
  ReleaseRecord,
} from "../src/types.js"

export const REPOSITORY = "example-org/release-sandbox"
export const REPOSITORY_ID = 123456789
export const PAGE_ID = "550e8400-e29b-41d4-a716-446655440000"
export const RELEASE_ID = 987654
export const COMMIT = "a".repeat(40)
export const NAME = "Release v1.2.3"
export const BODY = "Approved release notes\n"

export function makeInput(
  overrides: Partial<PublishPreparedReleaseInput> = {}
): PublishPreparedReleaseInput {
  const input: PublishPreparedReleaseInput = {
    approvalPageId: PAGE_ID,
    approvalRevision: "release-approval-7",
    approvalFingerprint: "0".repeat(64),
    repository: REPOSITORY,
    releaseId: RELEASE_ID,
    tag: "v1.2.3",
    targetCommit: COMMIT,
    nameSha256: sha256(NAME),
    bodySha256: sha256(BODY),
    prerelease: false,
    makeLatest: "true",
    requiredChecks: [{ kind: "check_run", name: "build", appId: 15368 }],
    requiredAssets: [
      {
        name: "app.tar.gz",
        sizeBytes: 512,
        sha256: "b".repeat(64),
      },
    ],
    ...overrides,
  }
  input.approvalFingerprint = sha256(canonicalPacket(input))
  return input
}

export function makeReleaseRecord(
  overrides: Partial<ReleaseRecord> = {}
): ReleaseRecord {
  return {
    releaseId: RELEASE_ID,
    repositoryId: REPOSITORY_ID,
    repository: REPOSITORY,
    tag: "v1.2.3",
    targetCommit: COMMIT,
    url: `https://github.com/${REPOSITORY}/releases/tag/v1.2.3`,
    nameSha256: sha256(NAME),
    bodySha256: sha256(BODY),
    prerelease: false,
    publishedAt: "2026-07-03T12:00:00Z",
    ...overrides,
  }
}
