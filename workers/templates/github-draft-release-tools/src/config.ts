export type Environment = Record<string, string | undefined>

export type RuntimeConfig = {
  repository: string
  repositoryId: number
  githubRequestTimeoutMs: number
}

function required(env: Environment, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is not set`)
  return value
}

export function normalizeRepository(value: string): string {
  const repository = value.trim().toLowerCase()
  if (
    repository.length > 201 ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,99})\/[a-z0-9](?:[a-z0-9._-]{0,99})$/.test(
      repository
    )
  ) {
    throw new Error('GITHUB_REPOSITORY must use the "owner/repository" form')
  }
  return repository
}

function positiveInteger(env: Environment, name: string): number {
  const value = Number(required(env, name))
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

export function loadConfig(env: Environment = process.env): RuntimeConfig {
  return {
    repository: normalizeRepository(required(env, "GITHUB_REPOSITORY")),
    repositoryId: positiveInteger(env, "GITHUB_REPOSITORY_ID"),
    githubRequestTimeoutMs: 8_000,
  }
}
