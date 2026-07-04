import { assertReceipt, MAX_DEPENDENCIES, MAX_NODES } from "./policy.js"
import type { OperationState } from "./types.js"

type Fetch = typeof globalThis.fetch
const MAX_REDIS_RESPONSE_BYTES = 256_000

export type OperationIdentity = {
  idempotencyKey: string
  operationId: string
  publicationKey: string
  providerPolicyFingerprint: string
}

export type InitialClaim = "claimed" | "replay" | "conflict"
export type LeaseClaim = {
  acquired: boolean
  retryAfterSeconds: number | null
  fencingEpoch: number | null
}

export type LeaseOwnership = { token: string; fencingEpoch: number }

export interface OperationLedger {
  claimPublication(
    identity: OperationIdentity,
    state: OperationState
  ): Promise<InitialClaim>
  readPublicationOwner(identity: OperationIdentity): Promise<string | null>
  readState(identity: OperationIdentity): Promise<OperationState | null>
  acquireLease(identity: OperationIdentity, token: string): Promise<LeaseClaim>
  renewLease(
    identity: OperationIdentity,
    lease: LeaseOwnership
  ): Promise<boolean>
  putState(
    identity: OperationIdentity,
    previous: OperationState,
    state: OperationState,
    lease: LeaseOwnership
  ): Promise<void>
  releaseLease(
    identity: OperationIdentity,
    lease: LeaseOwnership
  ): Promise<void>
}

export class LedgerError extends Error {
  readonly retryable = true
  constructor(message: string) {
    super(message)
    this.name = "LedgerError"
  }
}

export const CLAIM_SCRIPT =
  "local owner=redis.call('get',KEYS[1]); local state=redis.call('get',KEYS[2]); if owner and owner~=ARGV[1] then return 'CONFLICT' end; if owner then if not state then return 'CORRUPT' end; return 'REPLAY' end; if state then return 'CORRUPT' end; redis.call('set',KEYS[1],ARGV[1]); redis.call('set',KEYS[2],ARGV[2]); return 'CLAIMED'"
export const ACQUIRE_SCRIPT =
  "if redis.call('exists',KEYS[1])==1 then return {0,redis.call('pttl',KEYS[1])} end; local epoch=redis.call('incr',KEYS[2]); redis.call('psetex',KEYS[1],ARGV[2],tostring(epoch)..':'..ARGV[1]); return {1,epoch}"
export const RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"
export const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"
export const PUT_STATE_SCRIPT =
  "if redis.call('get',KEYS[1])~=ARGV[1] then return 'OWNER' end; if redis.call('get',KEYS[2])~=ARGV[2] then return 'LEASE' end; if redis.call('get',KEYS[3])~=ARGV[3] then return 'STALE' end; redis.call('set',KEYS[3],ARGV[4]); return 'OK'"

type RedisResponse = { result?: unknown; error?: unknown }

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

async function readBoundedJson(response: Response): Promise<RedisResponse> {
  const declared = response.headers.get("content-length")
  if (declared !== null && Number(declared) > MAX_REDIS_RESPONSE_BYTES) {
    await discardBody(response)
    throw new LedgerError("Redis response exceeded the fixed body limit")
  }
  if (!response.body) throw new LedgerError("Redis returned an empty response")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_REDIS_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new LedgerError("Redis response exceeded the fixed body limit")
    }
    chunks.push(value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as RedisResponse
  } catch {
    throw new LedgerError("Redis returned invalid JSON")
  }
}

const SHA256 = /^[a-f0-9]{64}$/
const PAGE_ID = /^[a-f0-9]{32}$/
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,19}$/
const OPERATION_ID = /^jplan_[a-f0-9]{24}$/
const IDEMPOTENCY_KEY = /^jira-plan:[a-f0-9]{64}$/
const NODE_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/
const NUMERIC_ID = /^[1-9][0-9]{0,31}$/

function exactKeys(value: object, expected: string[]): boolean {
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

function validateState(
  value: unknown,
  identity?: OperationIdentity
): OperationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LedgerError("Redis operation state has an invalid shape")
  }
  const state = value as OperationState
  if (
    !exactKeys(state, [
      "version",
      "operationId",
      "idempotencyKey",
      "planHash",
      "sourcePageId",
      "approvalRevision",
      "projectKey",
      "providerPolicyFingerprint",
      "stage",
      "nodes",
      "dependencies",
      "receipt",
      "receiptJson",
      "startedAt",
      "updatedAt",
    ]) ||
    state.version !== 2 ||
    !OPERATION_ID.test(state.operationId) ||
    !IDEMPOTENCY_KEY.test(state.idempotencyKey) ||
    state.operationId !==
      `jplan_${state.idempotencyKey.slice("jira-plan:".length, "jira-plan:".length + 24)}` ||
    !SHA256.test(state.planHash) ||
    !PAGE_ID.test(state.sourcePageId) ||
    typeof state.approvalRevision !== "string" ||
    state.approvalRevision.length < 1 ||
    state.approvalRevision.length > 160 ||
    !PROJECT_KEY.test(state.projectKey) ||
    !SHA256.test(state.providerPolicyFingerprint) ||
    ![
      "claimed",
      "publishing_nodes",
      "publishing_dependencies",
      "writing_receipt",
      "completed",
    ].includes(state.stage) ||
    !validIso(state.startedAt) ||
    !validIso(state.updatedAt) ||
    !Array.isArray(state.nodes) ||
    state.nodes.length < 1 ||
    state.nodes.length > MAX_NODES ||
    !Array.isArray(state.dependencies) ||
    state.dependencies.length > MAX_DEPENDENCIES
  ) {
    throw new LedgerError(
      "Redis operation state has invalid identity or fields"
    )
  }
  if (
    identity &&
    (state.operationId !== identity.operationId ||
      state.idempotencyKey !== identity.idempotencyKey ||
      state.providerPolicyFingerprint !== identity.providerPolicyFingerprint)
  ) {
    throw new LedgerError("Redis operation belongs to a different input")
  }
  const nodeKeys = new Set<string>()
  for (const node of state.nodes) {
    if (
      !node ||
      typeof node !== "object" ||
      Array.isArray(node) ||
      !exactKeys(node, [
        "nodeKey",
        "issueId",
        "issueKey",
        "url",
        "marker",
        "status",
        "attempt",
        "requestDisposition",
      ]) ||
      !NODE_KEY.test(node.nodeKey) ||
      nodeKeys.has(node.nodeKey) ||
      !["pending", "unknown", "created", "existing"].includes(node.status) ||
      !Number.isSafeInteger(node.attempt) ||
      node.attempt < 0 ||
      node.attempt > 100 ||
      ![
        "not_sent",
        "fenced",
        "outcome_unknown",
        "accepted",
        "definitely_rejected",
      ].includes(node.requestDisposition) ||
      typeof node.marker !== "string" ||
      node.marker.length > 64
    ) {
      throw new LedgerError("Redis node checkpoint is invalid")
    }
    nodeKeys.add(node.nodeKey)
    const hasIdentity = node.issueId !== null
    if (
      hasIdentity !== (node.issueKey !== null) ||
      hasIdentity !== (node.url !== null) ||
      (hasIdentity &&
        (!NUMERIC_ID.test(node.issueId as string) ||
          typeof node.issueKey !== "string" ||
          typeof node.url !== "string" ||
          !node.url.startsWith("https://"))) ||
      ["created", "existing"].includes(node.status) !== hasIdentity ||
      (["pending", "unknown"].includes(node.status) && hasIdentity)
    ) {
      throw new LedgerError("Redis node checkpoint has inconsistent identity")
    }
    if (
      (node.status === "pending" &&
        !["not_sent", "fenced", "definitely_rejected"].includes(
          node.requestDisposition
        )) ||
      (node.status === "unknown" &&
        node.requestDisposition !== "outcome_unknown") ||
      (["created", "existing"].includes(node.status) &&
        node.requestDisposition !== "accepted") ||
      (node.requestDisposition === "not_sent" && node.attempt !== 0) ||
      (["fenced", "outcome_unknown", "definitely_rejected"].includes(
        node.requestDisposition
      ) &&
        node.attempt < 1)
    ) {
      throw new LedgerError("Redis node checkpoint has invalid request state")
    }
  }
  const dependencyKeys = new Set<string>()
  for (const dependency of state.dependencies) {
    const key = `${dependency.blockerNodeKey}>${dependency.blockedNodeKey}`
    if (
      !dependency ||
      typeof dependency !== "object" ||
      Array.isArray(dependency) ||
      !exactKeys(dependency, [
        "blockerNodeKey",
        "blockedNodeKey",
        "status",
        "attempt",
        "requestDisposition",
      ]) ||
      !nodeKeys.has(dependency.blockerNodeKey) ||
      !nodeKeys.has(dependency.blockedNodeKey) ||
      dependencyKeys.has(key) ||
      !["pending", "unknown", "created", "existing"].includes(
        dependency.status
      ) ||
      !Number.isSafeInteger(dependency.attempt) ||
      dependency.attempt < 0 ||
      dependency.attempt > 100 ||
      ![
        "not_sent",
        "fenced",
        "outcome_unknown",
        "accepted",
        "definitely_rejected",
      ].includes(dependency.requestDisposition)
    ) {
      throw new LedgerError("Redis dependency checkpoint is invalid")
    }
    dependencyKeys.add(key)
    if (
      (dependency.status === "pending" &&
        !["not_sent", "fenced", "definitely_rejected"].includes(
          dependency.requestDisposition
        )) ||
      (dependency.status === "unknown" &&
        dependency.requestDisposition !== "outcome_unknown") ||
      (["created", "existing"].includes(dependency.status) &&
        dependency.requestDisposition !== "accepted") ||
      (dependency.requestDisposition === "not_sent" &&
        dependency.attempt !== 0) ||
      (["fenced", "outcome_unknown", "definitely_rejected"].includes(
        dependency.requestDisposition
      ) &&
        dependency.attempt < 1)
    ) {
      throw new LedgerError(
        "Redis dependency checkpoint has invalid request state"
      )
    }
  }
  if (state.stage === "completed" || state.stage === "writing_receipt") {
    if (
      state.nodes.some(
        (node) =>
          !["created", "existing"].includes(node.status) ||
          node.requestDisposition !== "accepted"
      ) ||
      state.dependencies.some(
        (dependency) =>
          !["created", "existing"].includes(dependency.status) ||
          dependency.requestDisposition !== "accepted"
      )
    ) {
      throw new LedgerError(
        "Receipt-stage Redis state contains unfinished Jira work"
      )
    }
    if (state.receipt === null || typeof state.receiptJson !== "string") {
      throw new LedgerError("Completed Redis state is missing its receipt")
    }
    try {
      assertReceipt(state.receipt)
    } catch {
      throw new LedgerError("Redis canonical receipt is invalid")
    }
    if (
      JSON.stringify(state.receipt) !== state.receiptJson ||
      state.receipt.operationId !== state.operationId ||
      state.receipt.idempotencyKey !== state.idempotencyKey ||
      state.receipt.planHash !== state.planHash ||
      state.receipt.approvalPageId !== state.sourcePageId ||
      state.receipt.approvalRevision !== state.approvalRevision ||
      state.receipt.projectKey !== state.projectKey ||
      state.receipt.providerPolicyFingerprint !==
        state.providerPolicyFingerprint ||
      state.receipt.startedAt !== state.startedAt ||
      state.receipt.status !== "completed" ||
      !state.receipt.changed ||
      state.receipt.replay ||
      !state.receipt.notionReceiptWritten ||
      state.receipt.completedAt === null ||
      state.receipt.nodes.length !== state.nodes.length ||
      state.receipt.dependencies.length !== state.dependencies.length
    ) {
      throw new LedgerError("Redis receipt does not match its operation")
    }
    for (let index = 0; index < state.nodes.length; index += 1) {
      const durable = state.nodes[index]
      const receipt = state.receipt.nodes[index]
      if (
        receipt.nodeKey !== durable.nodeKey ||
        receipt.issueId !== durable.issueId ||
        receipt.issueKey !== durable.issueKey ||
        receipt.url !== durable.url ||
        receipt.action !==
          (durable.status === "created" ? "created" : "existing")
      ) {
        throw new LedgerError(
          "Redis receipt node does not match its checkpoint"
        )
      }
    }
    for (let index = 0; index < state.dependencies.length; index += 1) {
      const durable = state.dependencies[index]
      const receipt = state.receipt.dependencies[index]
      if (
        receipt.blockerNodeKey !== durable.blockerNodeKey ||
        receipt.blockedNodeKey !== durable.blockedNodeKey ||
        receipt.action !==
          (durable.status === "created" ? "created" : "existing")
      ) {
        throw new LedgerError(
          "Redis receipt dependency does not match its checkpoint"
        )
      }
    }
  } else if (state.receipt !== null || state.receiptJson !== null) {
    throw new LedgerError("Incomplete Redis state contains a final receipt")
  }
  return state
}

const STAGE_ORDER: OperationState["stage"][] = [
  "claimed",
  "publishing_nodes",
  "publishing_dependencies",
  "writing_receipt",
  "completed",
]

function validateTransition(
  previousValue: OperationState,
  nextValue: OperationState
): void {
  const previous = validateState(previousValue)
  const next = validateState(nextValue)
  for (const key of [
    "version",
    "operationId",
    "idempotencyKey",
    "planHash",
    "sourcePageId",
    "approvalRevision",
    "projectKey",
    "providerPolicyFingerprint",
    "startedAt",
  ] as const) {
    if (previous[key] !== next[key]) {
      throw new LedgerError(`Redis state transition changed immutable ${key}`)
    }
  }
  if (
    STAGE_ORDER.indexOf(next.stage) < STAGE_ORDER.indexOf(previous.stage) ||
    Date.parse(next.updatedAt) < Date.parse(previous.updatedAt) ||
    previous.nodes.length !== next.nodes.length ||
    previous.dependencies.length !== next.dependencies.length
  ) {
    throw new LedgerError("Redis state transition is not monotonic")
  }
  for (let index = 0; index < previous.nodes.length; index += 1) {
    validateCheckpointTransition(previous.nodes[index], next.nodes[index])
  }
  for (let index = 0; index < previous.dependencies.length; index += 1) {
    validateCheckpointTransition(
      previous.dependencies[index],
      next.dependencies[index]
    )
  }
  if (previous.receiptJson !== null) {
    if (
      next.receiptJson !== previous.receiptJson ||
      JSON.stringify(next.receipt) !== JSON.stringify(previous.receipt)
    ) {
      throw new LedgerError("Redis canonical receipt is immutable")
    }
  }
}

function validateCheckpointTransition(
  previous: {
    status: string
    attempt: number
    requestDisposition: string
    [key: string]: unknown
  },
  next: {
    status: string
    attempt: number
    requestDisposition: string
    [key: string]: unknown
  }
): void {
  for (const key of Object.keys(previous)) {
    if (
      ![
        "status",
        "attempt",
        "requestDisposition",
        "issueId",
        "issueKey",
        "url",
      ].includes(key) &&
      previous[key] !== next[key]
    ) {
      throw new LedgerError("Redis checkpoint identity changed")
    }
  }
  if (JSON.stringify(previous) === JSON.stringify(next)) return
  const from = `${previous.status}:${previous.requestDisposition}`
  const to = `${next.status}:${next.requestDisposition}`
  const sameAttempt = next.attempt === previous.attempt
  const incremented = next.attempt === previous.attempt + 1
  const allowed =
    ((from === "pending:not_sent" || from === "pending:definitely_rejected") &&
      to === "pending:fenced" &&
      incremented) ||
    (from === "pending:fenced" &&
      [
        "unknown:outcome_unknown",
        "created:accepted",
        "pending:definitely_rejected",
      ].includes(to) &&
      sameAttempt) ||
    ([
      "pending:not_sent",
      "pending:fenced",
      "pending:definitely_rejected",
      "unknown:outcome_unknown",
    ].includes(from) &&
      to === "existing:accepted" &&
      sameAttempt)
  if (!allowed) {
    throw new LedgerError(
      `Redis checkpoint transition ${from} -> ${to} is invalid`
    )
  }
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

  async claimPublication(
    identity: OperationIdentity,
    state: OperationState
  ): Promise<InitialClaim> {
    validateState(state, identity)
    const serialized = JSON.stringify(state)
    const command = [
      "EVAL",
      CLAIM_SCRIPT,
      "2",
      this.publicationKey(identity),
      this.stateKey(identity),
      identity.idempotencyKey,
      serialized,
    ]
    try {
      const result = await this.command(command)
      if (result === "CLAIMED") return "claimed"
      if (result === "REPLAY") return "replay"
      if (result === "CONFLICT") return "conflict"
      throw new LedgerError("Redis returned an invalid claim result")
    } catch {
      const [owner, observed] = await Promise.all([
        this.command(["GET", this.publicationKey(identity)]),
        this.command(["GET", this.stateKey(identity)]),
      ])
      if (owner !== identity.idempotencyKey) {
        if (typeof owner === "string") return "conflict"
        throw new LedgerError("Redis publication claim was not confirmed")
      }
      if (typeof observed !== "string") {
        throw new LedgerError("Redis publication state was not confirmed")
      }
      validateState(JSON.parse(observed), identity)
      return "replay"
    }
  }

  async readState(identity: OperationIdentity): Promise<OperationState | null> {
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

  async readPublicationOwner(
    identity: OperationIdentity
  ): Promise<string | null> {
    const result = await this.command(["GET", this.publicationKey(identity)])
    if (result === null) return null
    if (typeof result !== "string") {
      throw new LedgerError("Redis publication owner is not a string")
    }
    return result
  }

  async acquireLease(
    identity: OperationIdentity,
    token: string
  ): Promise<LeaseClaim> {
    const key = this.leaseKey(identity)
    try {
      const result = await this.command([
        "EVAL",
        ACQUIRE_SCRIPT,
        "2",
        key,
        this.leaseEpochKey(identity),
        token,
        String(this.options.leaseTtlMs),
      ])
      if (
        Array.isArray(result) &&
        result.length === 2 &&
        result[0] === 1 &&
        Number.isSafeInteger(result[1]) &&
        (result[1] as number) > 0
      ) {
        return {
          acquired: true,
          retryAfterSeconds: null,
          fencingEpoch: result[1] as number,
        }
      }
      if (Array.isArray(result) && result.length === 2 && result[0] === 0) {
        const ttl = result[1]
        return {
          acquired: false,
          retryAfterSeconds:
            typeof ttl === "number" && ttl >= 0
              ? Math.max(1, Math.ceil(ttl / 1_000))
              : null,
          fencingEpoch: null,
        }
      }
      throw new LedgerError("Redis returned an invalid lease result")
    } catch {
      const owner = await this.command(["GET", key])
      if (typeof owner === "string" && owner.endsWith(`:${token}`)) {
        const epoch = Number(owner.slice(0, owner.indexOf(":")))
        if (Number.isSafeInteger(epoch) && epoch > 0) {
          return {
            acquired: true,
            retryAfterSeconds: null,
            fencingEpoch: epoch,
          }
        }
      }
      throw new LedgerError("Redis lease claim was unavailable")
    }
  }

  async renewLease(
    identity: OperationIdentity,
    lease: LeaseOwnership
  ): Promise<boolean> {
    const owner = this.leaseOwner(lease)
    const command = [
      "EVAL",
      RENEW_SCRIPT,
      "1",
      this.leaseKey(identity),
      owner,
      String(this.options.leaseTtlMs),
    ]
    try {
      return (await this.command(command)) === 1
    } catch {
      const owner = await this.command(["GET", this.leaseKey(identity)])
      if (owner !== this.leaseOwner(lease)) return false
      return (await this.command(command)) === 1
    }
  }

  async putState(
    identity: OperationIdentity,
    previous: OperationState,
    state: OperationState,
    lease: LeaseOwnership
  ): Promise<void> {
    validateState(previous, identity)
    validateState(state, identity)
    validateTransition(previous, state)
    const previousSerialized = JSON.stringify(previous)
    const serialized = JSON.stringify(state)
    const key = this.stateKey(identity)
    let result: unknown
    try {
      result = await this.command([
        "EVAL",
        PUT_STATE_SCRIPT,
        "3",
        this.publicationKey(identity),
        this.leaseKey(identity),
        key,
        identity.idempotencyKey,
        this.leaseOwner(lease),
        previousSerialized,
        serialized,
      ])
    } catch {
      try {
        const confirmed = await this.command([
          "EVAL",
          PUT_STATE_SCRIPT,
          "3",
          this.publicationKey(identity),
          this.leaseKey(identity),
          key,
          identity.idempotencyKey,
          this.leaseOwner(lease),
          serialized,
          serialized,
        ])
        if (confirmed === "OK") return
      } catch {
        // The second atomic confirmation was also unavailable.
      }
      throw new LedgerError("Redis compare-and-swap was not confirmed")
    }
    if (result !== "OK") {
      throw new LedgerError(
        result === "OWNER"
          ? "Redis publication owner changed"
          : result === "LEASE"
            ? "Redis publication lease is stale"
            : "Redis operation state changed concurrently"
      )
    }
  }

  async releaseLease(
    identity: OperationIdentity,
    lease: LeaseOwnership
  ): Promise<void> {
    await this.command([
      "EVAL",
      RELEASE_SCRIPT,
      "1",
      this.leaseKey(identity),
      this.leaseOwner(lease),
    ])
  }

  private stateKey(identity: OperationIdentity): string {
    return `notion-cookbook:jira-plan:v2:${identity.idempotencyKey}:state`
  }

  private publicationKey(identity: OperationIdentity): string {
    return `notion-cookbook:jira-plan:v2:${identity.publicationKey}:publication`
  }

  private leaseKey(identity: OperationIdentity): string {
    return `notion-cookbook:jira-plan:v2:${identity.publicationKey}:lease`
  }

  private leaseEpochKey(identity: OperationIdentity): string {
    return `notion-cookbook:jira-plan:v2:${identity.publicationKey}:lease-epoch`
  }

  private leaseOwner(lease: LeaseOwnership): string {
    return `${lease.fencingEpoch}:${lease.token}`
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
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      })
      if (!response.ok) {
        await discardBody(response)
        throw new LedgerError(
          `Redis REST request failed (HTTP ${response.status})`
        )
      }
      const decoded = await readBoundedJson(response)
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
