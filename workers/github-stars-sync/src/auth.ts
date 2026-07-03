// GitHub authentication for a user-owned resource. Installation tokens are
// intentionally unsupported because GET /user/starred requires user identity.

import type { UserManagedOAuthConfiguration } from "@notionhq/workers"

export type GitHubAuthMode = "pat" | "user"
export type GetAccessToken = () => Promise<string>
export type GetExpectedUserId = () => string

type Environment = Record<string, string | undefined>

type OAuthRegistrar = {
  oauth(
    key: string,
    config: UserManagedOAuthConfiguration
  ): { accessToken(): Promise<string> }
}

type AuthDependencies = {
  env?: Environment
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
  if (value === "pat" || value === "user") return value

  throw new Error('GITHUB_AUTH_MODE must be either "pat" or "user".')
}

export function getExpectedGitHubUserId(
  env: Environment = process.env
): string {
  const value = requireEnv(env, "GITHUB_USER_ID")
  if (!/^[1-9]\d{0,15}$/.test(value)) {
    throw new Error("GITHUB_USER_ID must be a positive numeric GitHub user ID.")
  }
  const userId = Number(value)
  if (!Number.isSafeInteger(userId)) {
    throw new Error("GITHUB_USER_ID must be a safe integer.")
  }
  return String(userId)
}

export function createGitHubAccessTokenProvider(
  worker: OAuthRegistrar,
  dependencies: AuthDependencies = {}
): GetAccessToken {
  const env = dependencies.env ?? process.env
  const mode = getGitHubAuthMode(env)
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim() ?? ""
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim() ?? ""

  // Register OAuth in every mode so the initial PAT deployment can expose its
  // callback URL before GitHub App credentials have been configured.
  const oauth = worker.oauth(GITHUB_OAUTH_CAPABILITY_KEY, {
    name: "github-app-user",
    clientId,
    clientSecret,
    authorizationEndpoint: GITHUB_AUTHORIZE_URL,
    tokenEndpoint: GITHUB_TOKEN_URL,
    // GitHub Apps use configured app permissions, not OAuth scopes.
    scope: "",
  })

  if (mode === "user") {
    if (!clientId || !clientSecret) {
      return async () => {
        requireEnv(env, "GITHUB_APP_CLIENT_ID")
        requireEnv(env, "GITHUB_APP_CLIENT_SECRET")
        return oauth.accessToken()
      }
    }
    return async () => oauth.accessToken()
  }

  return async () => requireEnv(env, "GITHUB_TOKEN")
}
