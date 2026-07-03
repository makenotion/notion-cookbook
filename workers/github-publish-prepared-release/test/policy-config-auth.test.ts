import assert from "node:assert/strict"
import test from "node:test"

import {
  createTimeoutFetch,
  createGitHubAccessTokenProvider,
  installationTokenRequest,
} from "../src/auth.js"
import {
  loadConfig,
  parseAllowedRepositories,
  type Environment,
} from "../src/config.js"
import {
  buildIdentity,
  canonicalPacket,
  sha256,
  validateInput,
} from "../src/policy.js"
import { makeInput, RELEASE_ID, REPOSITORY_ID } from "./fixtures.js"

test("validates a canonical approved packet and stable identities", () => {
  const first = makeInput()
  assert.doesNotThrow(() => validateInput(first))

  const second = makeInput({ approvalRevision: "release-approval-8" })
  const firstIdentity = buildIdentity(first, REPOSITORY_ID)
  const secondIdentity = buildIdentity(second, REPOSITORY_ID)
  assert.notEqual(firstIdentity.idempotencyKey, secondIdentity.idempotencyKey)
  assert.equal(firstIdentity.resourceKey, secondIdentity.resourceKey)
  assert.equal(
    firstIdentity.resourceKey,
    `repository:${REPOSITORY_ID}:release:${RELEASE_ID}`
  )
})

test("rejects stale fingerprints and an unbound check-run identity", () => {
  const stale = makeInput()
  stale.bodySha256 = "c".repeat(64)
  assert.throws(() => validateInput(stale), /approvalFingerprint/)

  const missingApp = makeInput({
    requiredChecks: [
      { kind: "check_run", name: "build", appId: null },
    ] as unknown as ReturnType<typeof makeInput>["requiredChecks"],
  })
  assert.throws(() => validateInput(missingApp), /positive integer/)

  const unsupportedStatus = makeInput({
    requiredChecks: [
      { kind: "commit_status", name: "ci/legacy", appId: 1 },
    ] as unknown as ReturnType<typeof makeInput>["requiredChecks"],
  })
  assert.throws(() => validateInput(unsupportedStatus), /only check_run/)

  assert.throws(
    () => validateInput(makeInput({ prerelease: true, makeLatest: "true" })),
    /prerelease cannot use makeLatest=true/
  )
})

test("enforces input and malicious-text limits before hashing", () => {
  assert.throws(
    () => validateInput(makeInput({ tag: "refs/tags/main" })),
    /safe Git ref/
  )
  assert.throws(
    () => validateInput(makeInput({ tag: "v1\nforged" })),
    /control/
  )
  assert.throws(
    () =>
      validateInput(
        makeInput({
          requiredChecks: Array.from({ length: 21 }, (_, index) => ({
            kind: "check_run" as const,
            name: `check-${index}`,
            appId: 1,
          })),
        })
      ),
    /1-20/
  )
  assert.throws(
    () =>
      validateInput(
        makeInput({
          requiredAssets: Array.from({ length: 101 }, (_, index) => ({
            name: `asset-${index}.zip`,
            sizeBytes: index,
            sha256: "d".repeat(64),
          })),
        })
      ),
    /at most 100/
  )
})

test("canonical packet sorting makes approval independent of input array order", () => {
  const first = makeInput({
    requiredChecks: [
      { kind: "check_run", name: "test", appId: 2 },
      { kind: "check_run", name: "build", appId: 1 },
    ],
  })
  const second = {
    ...first,
    requiredChecks: [...first.requiredChecks]
      .reverse()
      .map(({ kind, name, appId }) => ({ appId, name, kind })),
    requiredAssets: first.requiredAssets.map(({ name, sizeBytes, sha256 }) => ({
      sha256,
      sizeBytes,
      name,
    })),
  }
  assert.equal(sha256(canonicalPacket(first)), sha256(canonicalPacket(second)))
})

const BASE_ENV: Environment = {
  GITHUB_ALLOWED_REPOSITORIES_JSON: JSON.stringify([
    { repository: "Example-Org/Release-Sandbox", repositoryId: REPOSITORY_ID },
  ]),
  UPSTASH_REDIS_REST_URL: "https://example-redis.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "test-token",
}

test("parses an immutable numeric repository allowlist", () => {
  const allowed = parseAllowedRepositories(
    BASE_ENV.GITHUB_ALLOWED_REPOSITORIES_JSON as string
  )
  assert.equal(allowed.get("example-org/release-sandbox"), REPOSITORY_ID)
  assert.throws(
    () =>
      parseAllowedRepositories(
        '[{"repository":"example/repo","repositoryId":1,"extra":true}]'
      ),
    /only repository/
  )
})

test("accepts only a credential-free Redis HTTPS origin", () => {
  assert.equal(
    loadConfig(BASE_ENV).redisUrl,
    "https://example-redis.upstash.io"
  )
  for (const url of [
    "http://example-redis.upstash.io",
    "https://user:pass@example-redis.upstash.io",
    "https://example-redis.upstash.io/commands",
    "https://example-redis.upstash.io?token=secret",
    "https://example-redis.upstash.io/#fragment",
  ]) {
    assert.throws(
      () => loadConfig({ ...BASE_ENV, UPSTASH_REDIS_REST_URL: url }),
      /HTTPS origin/
    )
  }
})

test("installation token request is restricted to one repository and exact permissions", () => {
  assert.deepEqual(installationTokenRequest(REPOSITORY_ID), {
    type: "installation",
    repositoryIds: [REPOSITORY_ID],
    permissions: {
      contents: "write",
      checks: "read",
      metadata: "read",
    },
  })
})

test("auth provider passes the exact repository ID; PAT is explicit fallback", async () => {
  let observedRepositoryId = 0
  const installation = createGitHubAccessTokenProvider(
    {
      GITHUB_AUTH_MODE: "installation",
      GITHUB_APP_CLIENT_ID: "Iv1.test",
      GITHUB_APP_INSTALLATION_ID: "123",
      GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(
        "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----"
      ).toString("base64"),
    },
    () => async (repositoryId) => {
      observedRepositoryId = repositoryId
      return "installation-token"
    }
  )
  assert.equal(await installation(REPOSITORY_ID), "installation-token")
  assert.equal(observedRepositoryId, REPOSITORY_ID)

  const pat = createGitHubAccessTokenProvider({
    GITHUB_AUTH_MODE: "pat",
    GITHUB_TOKEN: "fine-grained-pat",
  })
  assert.equal(await pat(REPOSITORY_ID), "fine-grained-pat")
})

test("GitHub App token HTTP is explicitly time bounded", async () => {
  const timedFetch = createTimeoutFetch(
    async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true }
        )
      }),
    1
  )
  await assert.rejects(timedFetch("https://api.github.test/token"))
})
