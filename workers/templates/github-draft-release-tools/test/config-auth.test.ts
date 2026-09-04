import assert from "node:assert/strict"
import test from "node:test"

import {
  createGitHubAccessTokenProvider,
  installationTokenRequest,
} from "../src/auth.js"
import { loadConfig } from "../src/config.js"

test("configuration selects one repository by name and immutable ID", () => {
  assert.deepEqual(
    loadConfig({
      GITHUB_REPOSITORY: " Acme/Widget ",
      GITHUB_REPOSITORY_ID: "42",
    }),
    {
      repository: "acme/widget",
      repositoryId: 42,
      githubRequestTimeoutMs: 8_000,
    }
  )
  assert.throws(
    () =>
      loadConfig({
        GITHUB_REPOSITORY: "acme/widget",
        GITHUB_REPOSITORY_ID: "not-an-id",
      }),
    /positive integer/
  )
})

test("GitHub App tokens are downscoped to one repository", async () => {
  assert.deepEqual(installationTokenRequest(42), {
    type: "installation",
    repositoryIds: [42],
    permissions: { contents: "write", metadata: "read" },
  })

  let factoryOptions: unknown
  let requestedRepositoryId: number | undefined
  const getToken = createGitHubAccessTokenProvider(
    {
      GITHUB_AUTH_MODE: "installation",
      GITHUB_APP_CLIENT_ID: "Iv1.example",
      GITHUB_APP_INSTALLATION_ID: "9",
      GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(
        "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----"
      ).toString("base64"),
    },
    (options) => {
      factoryOptions = options
      return async (repositoryId) => {
        requestedRepositoryId = repositoryId
        return "installation-token"
      }
    }
  )

  assert.equal(await getToken(42), "installation-token")
  assert.deepEqual(factoryOptions, {
    appId: "Iv1.example",
    installationId: 9,
    privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
  })
  assert.equal(requestedRepositoryId, 42)
})

test("PAT mode uses the configured token without creating app auth", async () => {
  const getToken = createGitHubAccessTokenProvider(
    { GITHUB_AUTH_MODE: "pat", GITHUB_TOKEN: "github-token" },
    () => {
      throw new Error("installation auth must not be created")
    }
  )

  assert.equal(await getToken(42), "github-token")
  assert.throws(
    () =>
      createGitHubAccessTokenProvider({
        GITHUB_AUTH_MODE: "unsupported",
      }),
    /must be "installation" or "pat"/
  )
})
