import { normalizeRepository, assertReceipt } from "./policy.js"
import type { OperationState, PublishReceipt, ReleaseRecord } from "./types.js"

type Fetch = typeof globalThis.fetch

export type LedgerIdentity = {
  idempotencyKey: string
  operationId: string
  inputFingerprint: string
  resourceKey: string
}

export type LeaseClaim = {
  acquired: boolean
  retryAfterSeconds: number | null
}

export interface OperationLedger {
  readState(identity: LedgerIdentity): Promise<OperationState | null>
  acquireLease(identity: LedgerIdentity, token: string): Promise<LeaseClaim>
  renewLease(identity: LedgerIdentity, token: string): Promise<boolean>
  putState(identity: LedgerIdentity, state: OperationState): Promise<void>
  releaseLease(identity: LedgerIdentity, token: string): Promise<void>
}

export class LedgerError extends Error {
  readonly retryable = true

  constructor(message: string) {
    super(message)
    this.name = "LedgerError"
  }
}

export const RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"
export const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

type RedisResponse = { result?: unknown; error?: unknown }

const SHA256 = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const OPERATION_ID = /^ghrel_[a-f0-9]{24}$/
const IDEMPOTENCY_KEY = /^github-release:[a-f0-9]{64}$/
const RESOURCE_KEY = /^repository:([1-9][0-9]*):release:([1-9][0-9]*)$/
const NOTION_PAGE_ID = /^[a-f0-9]{32}$/

function exactKeys(
  value: Record<string, unknown>,
  expected: string[]
): boolean {
  return (
    Object.keys(value).sort().join("\u0000") ===
    [...expected].sort().join("\u0000")
  )
}

function validIso(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 40 &&
    !Number.isNaN(Date.parse(value))
  )
}

function validateRelease(value: unknown): ReleaseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LedgerError("Redis release checkpoint has an invalid shape")
  }
  const release = value as Record<string, unknown>
  if (
    !exactKeys(release, [
      "releaseId",
      "repositoryId",
      "repository",
      "tag",
      "targetCommit",
      "url",
      "nameSha256",
      "bodySha256",
      "prerelease",
      "publishedAt",
    ]) ||
    !Number.isSafeInteger(release.releaseId) ||
    (release.releaseId as number) <= 0 ||
    !Number.isSafeInteger(release.repositoryId) ||
    (release.repositoryId as number) <= 0 ||
    typeof release.repository !== "string" ||
    release.repository.length > 140 ||
    typeof release.tag !== "string" ||
    release.tag.length < 1 ||
    Buffer.byteLength(release.tag, "utf8") > 128 ||
    typeof release.targetCommit !== "string" ||
    !COMMIT.test(release.targetCommit) ||
    typeof release.url !== "string" ||
    release.url.length > 2_048 ||
    typeof release.nameSha256 !== "string" ||
    !SHA256.test(release.nameSha256) ||
    typeof release.bodySha256 !== "string" ||
    !SHA256.test(release.bodySha256) ||
    typeof release.prerelease !== "boolean" ||
    !validIso(release.publishedAt)
  ) {
    throw new LedgerError("Redis release checkpoint has invalid fields")
  }
  try {
    if (normalizeRepository(release.repository) !== release.repository) {
      throw new Error("not canonical")
    }
    const url = new URL(release.url)
    const prefix = `/${release.repository}/releases/tag/`
    if (
      url.origin !== "https://github.com" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !url.pathname.toLowerCase().startsWith(prefix.toLowerCase()) ||
      decodeURIComponent(url.pathname.slice(prefix.length)) !== release.tag
    ) {
      throw new Error("unsafe URL")
    }
  } catch {
    throw new LedgerError(
      "Redis release checkpoint has invalid identity or URL"
    )
  }
  return release as unknown as ReleaseRecord
}

function validateReceiptJson(
  value: unknown,
  state: Pick<OperationState, "operationId" | "idempotencyKey">,
  release: ReleaseRecord
): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 2_000) {
    throw new LedgerError("Redis receipt JSON is missing or oversized")
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch {
    throw new LedgerError("Redis receipt JSON is invalid")
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new LedgerError("Redis receipt JSON has an invalid shape")
  }
  const receipt = decoded as Record<string, unknown>
  if (
    !exactKeys(receipt, [
      "version",
      "operationId",
      "idempotencyKey",
      "repository",
      "repositoryId",
      "releaseId",
      "releaseUrl",
      "tag",
      "targetCommit",
      "nameSha256",
      "bodySha256",
      "publishedAt",
    ]) ||
    receipt.version !== 1 ||
    receipt.operationId !== state.operationId ||
    receipt.idempotencyKey !== state.idempotencyKey ||
    receipt.repository !== release.repository ||
    receipt.repositoryId !== release.repositoryId ||
    receipt.releaseId !== release.releaseId ||
    receipt.releaseUrl !== release.url ||
    receipt.tag !== release.tag ||
    receipt.targetCommit !== release.targetCommit ||
    receipt.nameSha256 !== release.nameSha256 ||
    receipt.bodySha256 !== release.bodySha256 ||
    receipt.publishedAt !== release.publishedAt
  ) {
    throw new LedgerError(
      "Redis receipt JSON does not match its release checkpoint"
    )
  }
  return value
}

function validatePersistedReceipt(
  value: unknown,
  state: Pick<OperationState, "operationId" | "idempotencyKey">,
  release: ReleaseRecord
): PublishReceipt {
  try {
    assertReceipt(value as PublishReceipt)
  } catch {
    throw new LedgerError("Redis canonical receipt is invalid")
  }
  const receipt = value as PublishReceipt
  const releaseRecords = receipt.records.filter(
    (record) => record.system === "github" && record.kind === "release"
  )
  const notionRecords = receipt.records.filter(
    (record) => record.system === "notion" && record.kind === "release_packet"
  )
  const releaseRecord = releaseRecords[0]
  const notionRecord = notionRecords[0]
  if (
    receipt.operationId !== state.operationId ||
    receipt.idempotencyKey !== state.idempotencyKey ||
    !receipt.published ||
    !["completed", "no_op"].includes(receipt.status) ||
    receipt.changed !== (receipt.status === "completed") ||
    receipt.retryable ||
    receipt.resumeToken !== null ||
    receipt.repair !== null ||
    receipt.records.length !== 2 ||
    releaseRecords.length !== 1 ||
    notionRecords.length !== 1 ||
    !releaseRecord ||
    releaseRecord.id !== String(release.releaseId) ||
    releaseRecord.url !== release.url ||
    !notionRecord ||
    !NOTION_PAGE_ID.test(notionRecord.id) ||
    notionRecord.url !== `https://www.notion.so/${notionRecord.id}`
  ) {
    throw new LedgerError("Redis canonical receipt has inconsistent semantics")
  }
  return receipt
}

function validateState(
  value: unknown,
  identity?: LedgerIdentity
): OperationState {
  if (!value || typeof value !== "object") {
    throw new LedgerError("Redis operation state has an invalid shape")
  }
  if (Array.isArray(value)) {
    throw new LedgerError("Redis operation state has an invalid shape")
  }
  const raw = value as Record<string, unknown>
  if (
    !exactKeys(raw, [
      "version",
      "operationId",
      "idempotencyKey",
      "inputFingerprint",
      "stage",
      "release",
      "receipt",
      "receiptJson",
      "updatedAt",
    ])
  ) {
    throw new LedgerError("Redis operation state has unsupported fields")
  }
  const state = value as Partial<OperationState>
  if (
    state.version !== 1 ||
    typeof state.operationId !== "string" ||
    !OPERATION_ID.test(state.operationId) ||
    typeof state.idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY.test(state.idempotencyKey) ||
    state.operationId !==
      `ghrel_${state.idempotencyKey.slice("github-release:".length, "github-release:".length + 24)}` ||
    typeof state.inputFingerprint !== "string" ||
    !SHA256.test(state.inputFingerprint) ||
    !["claimed", "mutation_unknown", "published", "completed"].includes(
      String(state.stage)
    ) ||
    !validIso(state.updatedAt) ||
    state.operationId.length > 100 ||
    state.idempotencyKey.length > 200
  ) {
    throw new LedgerError("Redis operation state has invalid identity or stage")
  }
  if (
    identity &&
    (state.operationId !== identity.operationId ||
      state.idempotencyKey !== identity.idempotencyKey ||
      state.inputFingerprint !== identity.inputFingerprint ||
      !RESOURCE_KEY.test(identity.resourceKey))
  ) {
    throw new LedgerError("Redis operation state belongs to a different input")
  }
  if (state.stage === "claimed" || state.stage === "mutation_unknown") {
    if (
      state.release !== null ||
      state.receipt !== null ||
      state.receiptJson !== null
    ) {
      throw new LedgerError(
        "Pre-publication Redis state contains post-publication data"
      )
    }
  } else {
    const release = validateRelease(state.release)
    if (identity) {
      const resource = RESOURCE_KEY.exec(identity.resourceKey)
      if (
        !resource ||
        release.repositoryId !== Number(resource[1]) ||
        release.releaseId !== Number(resource[2])
      ) {
        throw new LedgerError(
          "Redis release checkpoint does not match the resource lease"
        )
      }
    }
    validateReceiptJson(state.receiptJson, state as OperationState, release)
    if (state.stage === "published" && state.receipt !== null) {
      throw new LedgerError(
        "Published Redis state contains a completed receipt"
      )
    }
    if (state.stage === "completed") {
      validatePersistedReceipt(state.receipt, state as OperationState, release)
    }
  }
  return state as OperationState
}

export class RedisOperationLedger implements OperationLedger {
  private readonly fetch: Fetch

  constructor(
    private readonly options: {
      url: string
      token: string
      requestTimeoutMs: number
      leaseTtlMs: number
      fetch?: Fetch
    }
  ) {
    this.fetch = options.fetch ?? globalThis.fetch
  }

  async readState(identity: LedgerIdentity): Promise<OperationState | null> {
    const result = await this.command(["GET", this.stateKey(identity)])
    if (result === null) return null
    if (typeof result !== "string") {
      throw new LedgerError("Redis operation state is not a string")
    }
    try {
      return validateState(JSON.parse(result), identity)
    } catch (error) {
      if (error instanceof LedgerError) throw error
      throw new LedgerError("Redis operation state is not valid JSON")
    }
  }

  async acquireLease(
    identity: LedgerIdentity,
    token: string
  ): Promise<LeaseClaim> {
    const key = this.leaseKey(identity)
    try {
      const result = await this.command([
        "SET",
        key,
        token,
        "NX",
        "PX",
        String(this.options.leaseTtlMs),
      ])
      if (result === "OK") return { acquired: true, retryAfterSeconds: null }
    } catch {
      // SET NX may have reached Redis even if the HTTP response did not return.
      // Ownership read-back makes that ambiguous claim safe to reconcile.
      const owner = await this.command(["GET", key])
      if (owner === token) return { acquired: true, retryAfterSeconds: null }
      throw new LedgerError("Redis lease claim was unavailable")
    }

    const ttl = await this.command(["PTTL", key])
    return {
      acquired: false,
      retryAfterSeconds:
        typeof ttl === "number" && ttl >= 0
          ? Math.max(1, Math.ceil(ttl / 1_000))
          : null,
    }
  }

  async renewLease(identity: LedgerIdentity, token: string): Promise<boolean> {
    const command = [
      "EVAL",
      RENEW_SCRIPT,
      "1",
      this.leaseKey(identity),
      token,
      String(this.options.leaseTtlMs),
    ]
    try {
      return (await this.command(command)) === 1
    } catch {
      // Token-checked renewal is idempotent. Retry it once only when read-back
      // still proves this invocation owns the lease.
      const owner = await this.command(["GET", this.leaseKey(identity)])
      if (owner !== token) return false
      return (await this.command(command)) === 1
    }
  }

  async putState(
    identity: LedgerIdentity,
    state: OperationState
  ): Promise<void> {
    validateState(state, identity)
    if (
      state.operationId !== identity.operationId ||
      state.idempotencyKey !== identity.idempotencyKey ||
      state.inputFingerprint !== identity.inputFingerprint
    ) {
      throw new LedgerError(
        "Refusing to persist operation state with different identity"
      )
    }
    const serialized = JSON.stringify(state)
    const key = this.stateKey(identity)
    try {
      const result = await this.command(["SET", key, serialized])
      if (result !== "OK")
        throw new LedgerError("Redis did not acknowledge state write")
    } catch {
      // SET is an idempotent replacement. Reconcile instead of assuming loss.
      const observed = await this.command(["GET", key])
      if (observed !== serialized) {
        throw new LedgerError("Redis operation state write was not confirmed")
      }
    }
  }

  async releaseLease(identity: LedgerIdentity, token: string): Promise<void> {
    await this.command([
      "EVAL",
      RELEASE_SCRIPT,
      "1",
      this.leaseKey(identity),
      token,
    ])
  }

  private stateKey(identity: LedgerIdentity): string {
    return `notion-cookbook:github-release:v1:${identity.idempotencyKey}:state`
  }

  private leaseKey(identity: LedgerIdentity): string {
    return `notion-cookbook:github-release:v1:${identity.resourceKey}:lease`
  }

  private async command(command: string[]): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      this.options.requestTimeoutMs
    )
    try {
      const response = await this.fetch(this.options.url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      })
      if (!response.ok) {
        await response.text().catch(() => "")
        throw new LedgerError(
          `Redis REST request failed (HTTP ${response.status})`
        )
      }
      const decoded = (await response.json()) as RedisResponse
      if (decoded.error !== undefined) {
        throw new LedgerError("Redis rejected an operation command")
      }
      return decoded.result
    } catch (error) {
      if (error instanceof LedgerError) throw error
      throw new LedgerError("Redis operation ledger is unavailable")
    } finally {
      clearTimeout(timer)
    }
  }
}
