import { createAppAuth } from "@octokit/auth-app"
import { request } from "@octokit/request"

import type { Environment } from "./config.js"

export type GitHubAuthMode = "installation" | "pat"
export type GetAccessToken = (repositoryId: number) => Promise<string>

type InstallationTokenFactory = (options: {
  appId: string
  privateKey: string
  installationId: number
}) => (repositoryId: number) => Promise<string>

export const GITHUB_AUTH_TIMEOUT_MS = 8_000

export function createTimeoutFetch(
  fetchImplementation: typeof globalThis.fetch,
  timeoutMs = GITHUB_AUTH_TIMEOUT_MS
): typeof globalThis.fetch {
  return (input, init = {}) => {
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout
    return fetchImplementation(input, { ...init, signal })
  }
}

function required(env: Environment, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is not set`)
  return value
}

export function getGitHubAuthMode(
  env: Environment = process.env
): GitHubAuthMode {
  const mode = env.GITHUB_AUTH_MODE?.trim().toLowerCase() || "installation"
  if (mode === "installation" || mode === "pat") return mode
  throw new Error('GITHUB_AUTH_MODE must be "installation" or "pat"')
}

function decodePrivateKey(env: Environment): string {
  const value = Buffer.from(
    required(env, "GITHUB_APP_PRIVATE_KEY_BASE64"),
    "base64"
  )
    .toString("utf8")
    .trim()
  if (
    !/^-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(value) ||
    !/-----END (?:RSA )?PRIVATE KEY-----$/.test(value)
  ) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY_BASE64 must decode to a PEM private key"
    )
  }
  return value
}

function positiveInteger(env: Environment, name: string): number {
  const value = Number(required(env, name))
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

const defaultInstallationTokenFactory: InstallationTokenFactory = (options) => {
  const auth = createAppAuth({
    ...options,
    request: request.defaults({
      headers: {
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "notion-cookbook-github-draft-release-tools",
      },
      request: { fetch: createTimeoutFetch(globalThis.fetch) },
    }),
  })
  return async (repositoryId) => {
    const result = await auth(installationTokenRequest(repositoryId))
    return result.token
  }
}

export function installationTokenRequest(repositoryId: number) {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new Error("repositoryId must be a positive integer")
  }
  return {
    type: "installation" as const,
    repositoryIds: [repositoryId],
    permissions: {
      contents: "write" as const,
      metadata: "read" as const,
    },
  }
}

export function createGitHubAccessTokenProvider(
  env: Environment = process.env,
  factory: InstallationTokenFactory = defaultInstallationTokenFactory
): GetAccessToken {
  if (getGitHubAuthMode(env) === "pat") {
    return async (_repositoryId) => required(env, "GITHUB_TOKEN")
  }

  let getInstallationToken:
    | ((repositoryId: number) => Promise<string>)
    | undefined
  return async (repositoryId) => {
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
      throw new Error("repositoryId must be a positive integer")
    }
    getInstallationToken ??= factory({
      appId: required(env, "GITHUB_APP_CLIENT_ID"),
      installationId: positiveInteger(env, "GITHUB_APP_INSTALLATION_ID"),
      privateKey: decodePrivateKey(env),
    })
    return getInstallationToken(repositoryId)
  }
}
