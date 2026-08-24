// GitHub authentication. One deployment uses one of three modes:
//   - installation: a GitHub App installation token (recommended)
//   - user: a GitHub App user access token managed by Notion Workers OAuth
//   - pat: a fine-grained personal access token

import type { UserManagedOAuthConfiguration } from "@notionhq/workers"
import { createAppAuth } from "@octokit/auth-app"

export type GitHubAuthMode = "installation" | "user" | "pat"
export type GetAccessToken = (repo: string) => Promise<string>

type Environment = Record<string, string | undefined>

type OAuthRegistrar = {
  oauth(
    key: string,
    config: UserManagedOAuthConfiguration
  ): { accessToken(): Promise<string> }
}

type InstallationAuthOptions = {
  appId: string
  privateKey: string
  installationId: number
}

type InstallationTokenFactory = (
  options: InstallationAuthOptions
) => () => Promise<string>

type AuthDependencies = {
  env?: Environment
  createInstallationToken?: InstallationTokenFactory
}

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"

export const GITHUB_OAUTH_CAPABILITY_KEY = "githubUserOAuth"

function requireEnv(env: Environment, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is not set.`)
  return value
}

export function getGitHubAuthMode(
  env: Environment = process.env
): GitHubAuthMode {
  const value = env.GITHUB_AUTH_MODE?.trim().toLowerCase() || "pat"
  if (value === "installation" || value === "user" || value === "pat") {
    return value
  }

  throw new Error(
    'GITHUB_AUTH_MODE must be one of "installation", "user", or "pat".'
  )
}

function positiveIntegerEnv(env: Environment, name: string): number {
  const raw = requireEnv(env, name)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`)
  }
  return value
}

function decodePrivateKey(env: Environment): string {
  const encoded = requireEnv(env, "GITHUB_APP_PRIVATE_KEY_BASE64")
  const privateKey = Buffer.from(encoded, "base64").toString("utf8").trim()

  if (
    !/^-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(privateKey) ||
    !/-----END (?:RSA )?PRIVATE KEY-----$/.test(privateKey)
  ) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY_BASE64 must decode to a PEM private key."
    )
  }

  return privateKey
}

const defaultInstallationTokenFactory: InstallationTokenFactory = (options) => {
  const auth = createAppAuth(options)
  return async () => {
    const authentication = await auth({ type: "installation" })
    return authentication.token
  }
}

/**
 * Selects and configures one GitHub credential source for this deployment.
 * The returned provider is repository-aware so multi-installation support can
 * be added later without changing the GitHub API client.
 */
export function createGitHubAccessTokenProvider(
  worker: OAuthRegistrar,
  dependencies: AuthDependencies = {}
): GetAccessToken {
  const env = dependencies.env ?? process.env
  const mode = getGitHubAuthMode(env)
  const oauthClientId = env.GITHUB_APP_CLIENT_ID?.trim() ?? ""
  const oauthClientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim() ?? ""
  const oauthIsConfigured = Boolean(oauthClientId && oauthClientSecret)

  // Register this for every mode so a first deployment can expose its OAuth
  // callback URL before the GitHub App client credentials have been created.
  const oauth = worker.oauth(GITHUB_OAUTH_CAPABILITY_KEY, {
    name: "github-app-user",
    clientId: oauthIsConfigured ? oauthClientId : "",
    clientSecret: oauthIsConfigured ? oauthClientSecret : "",
    authorizationEndpoint: GITHUB_AUTHORIZE_URL,
    tokenEndpoint: GITHUB_TOKEN_URL,
    // GitHub Apps use app permissions, not OAuth scopes.
    scope: "",
  })

  if (mode === "pat") {
    return async () => requireEnv(env, "GITHUB_TOKEN")
  }

  if (mode === "user") {
    return async () => oauth.accessToken()
  }

  const createInstallationToken =
    dependencies.createInstallationToken ?? defaultInstallationTokenFactory
  let installationToken: (() => Promise<string>) | undefined

  return async (_repo: string) => {
    // Secrets are normally added after the first deployment. Initialize the
    // strategy on its first request so that initial deployment can succeed.
    installationToken ??= createInstallationToken({
      // GitHub recommends the App's client ID as the JWT issuer. Octokit's
      // appId option accepts either the client ID or the numeric App ID.
      appId: requireEnv(env, "GITHUB_APP_CLIENT_ID"),
      privateKey: decodePrivateKey(env),
      installationId: positiveIntegerEnv(env, "GITHUB_APP_INSTALLATION_ID"),
    })
    return installationToken()
  }
}
