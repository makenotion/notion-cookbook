// State is intentionally plain JSON. Incremental traversals pin one
// updatedAfter boundary. Replacement traversals additionally prove that two
// complete provider inventories match before replace-mode deletion can run.

import { createHash } from "node:crypto"

import { isCredentialFingerprint } from "./credential.js"

export const SYNC_STATE_VERSION = 3
export const INITIAL_UPDATED_AFTER = new Date(0).toISOString()
export const CONSISTENCY_BUFFER_MS = 60_000
export const WATERMARK_OVERLAP_MS = 5 * 60_000
export const MAX_INCREMENTAL_CURSOR_PAGES = 10_000
export const MAX_REPLACEMENT_CURSOR_PAGES = 2_048
export const MAX_CURSOR_LENGTH = 4_096
export const MAX_SAFE_SYNC_STATE_BYTES = 240 * 1_024
export const MAX_REPLACEMENT_RECORDS = 10_000
// A record can require multiple uniqueness constraints (for example, both an
// upstream source ID and its unified Notion key). This is a guard-entry bound,
// not the advertised record capacity.
export const MAX_REPLACEMENT_IDENTITIES = 30_000
export const MAX_REPLACEMENT_RESTARTS = 3
export const MAX_INCREMENTAL_RESTARTS = 3

const CURSOR_FINGERPRINT_BYTES = 12
const IDENTITY_BLOOM_BYTES = 144 * 1_024
const IDENTITY_BLOOM_HASHES = 27
const DIGEST_PATTERN = /^[0-9a-f]{64}$/
const ZERO_DIGEST = "0".repeat(64)
const DIGEST_MODULUS = 1n << 256n
const textEncoder = new TextEncoder()

export type SyncPhase = "reader" | "readwise"
export type SourcesReconciliationPhase =
  | "collect-reader"
  | "readwise"
  | "reader"
export type ReconciliationPass = "observe" | "confirm" | "emit"

export type CursorGuardState = {
  pageCursor?: string
  cursorFingerprints?: string
  pageCount?: number
}

export type IncrementalSyncState = CursorGuardState & {
  stateVersion: typeof SYNC_STATE_VERSION
  credentialFingerprint: string
  updatedAfter: string
  checkpoint?: string
  paginationRestartCount?: number
}

export type SourcesIncrementalSyncState = IncrementalSyncState & {
  phase?: SyncPhase
}

export type InventoryDigest = {
  count: number
  xor: string
  sum: string
}

type InventoryBase = {
  providerCount: number
  raw: InventoryDigest
  output: InventoryDigest
  providerItems: InventoryDigest
  uncoveredRawCount: number
}

export type ProviderCountUnit = "raw" | "provider-items" | "both"

export type InventorySnapshot = InventoryBase & {
  providerCountUnit: ProviderCountUnit
}

export type ActiveInventory = InventoryBase & {
  providerCountUnit?: ProviderCountUnit
}

export type IdentityGuardState = {
  identityBloom?: string
  identityCount?: number
}

export type ReconciliationSyncState = CursorGuardState &
  IdentityGuardState & {
    stateVersion: typeof SYNC_STATE_VERSION
    credentialFingerprint: string
    pass?: ReconciliationPass
    restartCount?: number
    baseline?: InventorySnapshot
    active?: ActiveInventory
  }

export type SourcesReconciliationSyncState = Omit<
  ReconciliationSyncState,
  "baseline"
> & {
  phase?: SourcesReconciliationPhase
  baselineReadwise?: InventorySnapshot
  baselineReader?: InventorySnapshot
  collectedReader?: InventorySnapshot
  completedReadwise?: InventorySnapshot
}

export type InventoryIdentity = {
  namespace: string
  value: string
}

export type ProviderCountMode = "exact" | "export"

export class ReplacementInstabilityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReplacementInstabilityError"
  }
}

function isoDateTime(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Readwise sync state has an invalid ${label}.`)
  }
  return value
}

function validVersion(state: { stateVersion?: unknown } | undefined) {
  if (state && state.stateVersion !== SYNC_STATE_VERSION) {
    throw new Error(
      "Readwise sync state is incompatible; reset the sync state before retrying."
    )
  }
}

function validCredentialFingerprint(value: unknown, resource: string): string {
  if (!isCredentialFingerprint(value)) {
    throw new Error(
      `Readwise ${resource} state is missing its credential binding; reset this sync's state before retrying.`
    )
  }
  return value
}

export function boundCredentialFingerprint(
  state: { credentialFingerprint?: unknown } | undefined,
  currentFingerprint: string,
  resource: string
): string {
  const current = validCredentialFingerprint(currentFingerprint, resource)
  if (!state) return current
  const persisted = validCredentialFingerprint(
    state.credentialFingerprint,
    resource
  )
  if (persisted !== current) {
    throw new Error(
      `Readwise credentials changed for ${resource}. Verify the intended account, then explicitly reset this sync's state to rebind it.`
    )
  }
  return current
}

export function incrementalRestartCount(value: unknown): number {
  if (value === undefined) return 0
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_INCREMENTAL_RESTARTS
  ) {
    throw new Error(
      "Readwise incremental sync state has an invalid pagination restart count."
    )
  }
  return value as number
}

export function nextIncrementalRestartCount(
  value: unknown,
  resource: string
): number {
  const current = incrementalRestartCount(value)
  if (current >= MAX_INCREMENTAL_RESTARTS) {
    throw new Error(
      `Readwise ${resource} pagination remained unstable after ${MAX_INCREMENTAL_RESTARTS} retries; reset this sync's continuation state before retrying.`
    )
  }
  return current + 1
}

function validPageCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_CURSOR_LENGTH
  ) {
    throw new Error("Readwise sync state has an invalid pageCursor.")
  }
  return value
}

function cursorFingerprint(value: string): Buffer {
  return createHash("sha256")
    .update(value)
    .digest()
    .subarray(0, CURSOR_FINGERPRINT_BYTES)
}

function decodedCursorFingerprints(
  state: CursorGuardState | undefined,
  maximumPages: number
): { bytes: Buffer; fingerprints: Set<string>; count: number } {
  const cursor = validPageCursor(state?.pageCursor)
  const encoded = state?.cursorFingerprints
  const declaredCount = state?.pageCount
  if (
    cursor === undefined &&
    encoded === undefined &&
    declaredCount === undefined
  ) {
    return { bytes: Buffer.alloc(0), fingerprints: new Set(), count: 0 }
  }
  if (
    cursor === undefined ||
    typeof encoded !== "string" ||
    !encoded ||
    !Number.isSafeInteger(declaredCount) ||
    (declaredCount as number) < 1 ||
    (declaredCount as number) > maximumPages
  ) {
    throw new Error("Readwise sync state has an invalid cursor history.")
  }
  const bytes = Buffer.from(encoded, "base64url")
  if (
    bytes.toString("base64url") !== encoded ||
    bytes.length % CURSOR_FINGERPRINT_BYTES !== 0 ||
    bytes.length / CURSOR_FINGERPRINT_BYTES !== declaredCount
  ) {
    throw new Error("Readwise sync state has an invalid cursor history.")
  }
  const fingerprints = new Set<string>()
  for (
    let offset = 0;
    offset < bytes.length;
    offset += CURSOR_FINGERPRINT_BYTES
  ) {
    const fingerprint = bytes
      .subarray(offset, offset + CURSOR_FINGERPRINT_BYTES)
      .toString("base64url")
    if (fingerprints.has(fingerprint)) {
      throw new Error("Readwise sync state repeats a cursor fingerprint.")
    }
    fingerprints.add(fingerprint)
  }
  if (
    bytes
      .subarray(bytes.length - CURSOR_FINGERPRINT_BYTES)
      .toString("base64url") !== cursorFingerprint(cursor).toString("base64url")
  ) {
    throw new Error("Readwise sync state does not guard its current cursor.")
  }
  return { bytes, fingerprints, count: declaredCount as number }
}

export function incrementalWindow(
  state: IncrementalSyncState | undefined,
  currentFingerprint: string,
  now = Date.now()
): {
  credentialFingerprint: string
  updatedAfter: string
  checkpoint: string
  pageCursor?: string
} {
  validVersion(state)
  if (state) boundedSyncState(state, "incremental")
  const credentialFingerprint = boundCredentialFingerprint(
    state,
    currentFingerprint,
    "incremental"
  )
  incrementalRestartCount(state?.paginationRestartCount)
  if (!Number.isFinite(now) || now < 0) {
    throw new Error("Readwise sync clock is invalid.")
  }

  const updatedAfter = state
    ? isoDateTime(state.updatedAfter, "updatedAfter")
    : INITIAL_UPDATED_AFTER
  const checkpoint = state?.checkpoint
    ? isoDateTime(state.checkpoint, "checkpoint")
    : new Date(Math.max(0, now - CONSISTENCY_BUFFER_MS)).toISOString()
  const pageCursor = validPageCursor(state?.pageCursor)

  if (state?.checkpoint === undefined && pageCursor !== undefined) {
    throw new Error(
      "Readwise sync state cannot resume pageCursor without a pinned checkpoint."
    )
  }
  if (Date.parse(updatedAfter) > Date.parse(checkpoint)) {
    throw new Error("Readwise sync state advances beyond its checkpoint.")
  }
  decodedCursorFingerprints(state, MAX_INCREMENTAL_CURSOR_PAGES)

  return {
    credentialFingerprint,
    updatedAfter,
    checkpoint,
    ...(pageCursor ? { pageCursor } : {}),
  }
}

export function nextCursorState(
  state: CursorGuardState | undefined,
  nextPageCursor: string | undefined,
  resourceName: string,
  maximumPages = MAX_INCREMENTAL_CURSOR_PAGES
): Required<CursorGuardState> {
  const cursor = validPageCursor(nextPageCursor)
  if (!cursor) {
    throw new Error(
      `Readwise ${resourceName} pagination is missing nextPageCursor.`
    )
  }

  const decoded = decodedCursorFingerprints(state, maximumPages)
  const fingerprint = cursorFingerprint(cursor)
  const encoded = fingerprint.toString("base64url")
  if (decoded.fingerprints.has(encoded)) {
    throw new ReplacementInstabilityError(
      `Readwise ${resourceName} pagination repeated a cursor.`
    )
  }
  const pageCount = decoded.count + 1
  if (pageCount > maximumPages) {
    throw new Error(
      `Readwise ${resourceName} pagination exceeded ${maximumPages} pages.`
    )
  }

  return {
    pageCursor: cursor,
    cursorFingerprints: Buffer.concat([decoded.bytes, fingerprint]).toString(
      "base64url"
    ),
    pageCount,
  }
}

export function completedIncrementalState(
  checkpoint: string,
  credentialFingerprint: string
): IncrementalSyncState {
  validCredentialFingerprint(credentialFingerprint, "incremental")
  const parsed = Date.parse(isoDateTime(checkpoint, "checkpoint"))
  return {
    stateVersion: SYNC_STATE_VERSION,
    credentialFingerprint,
    updatedAfter: new Date(
      Math.max(0, parsed - WATERMARK_OVERLAP_MS)
    ).toISOString(),
  }
}

export function phase(value: unknown): SyncPhase {
  if (value === undefined) return "readwise"
  if (value !== "reader" && value !== "readwise") {
    throw new Error("Readwise source sync state has an invalid phase.")
  }
  return value
}

export function sourcesReconciliationPhase(
  value: unknown
): SourcesReconciliationPhase {
  if (value === undefined) return "collect-reader"
  if (
    value !== "collect-reader" &&
    value !== "readwise" &&
    value !== "reader"
  ) {
    throw new Error(
      "Readwise source reconciliation state has an invalid phase."
    )
  }
  return value
}

export function reconciliationPass(value: unknown): ReconciliationPass {
  if (value === undefined) return "observe"
  if (value !== "observe" && value !== "confirm" && value !== "emit") {
    throw new Error("Readwise reconciliation state has an invalid pass.")
  }
  return value
}

export function reconciliationRestartCount(value: unknown): number {
  if (value === undefined) return 0
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_REPLACEMENT_RESTARTS
  ) {
    throw new Error(
      "Readwise reconciliation state has an invalid restart count."
    )
  }
  return value as number
}

export function nextReconciliationRestartCount(
  value: unknown,
  resource: string
): number {
  const current = reconciliationRestartCount(value)
  if (current >= MAX_REPLACEMENT_RESTARTS) {
    throw new Error(
      `Readwise ${resource} replacement remained unstable after ${MAX_REPLACEMENT_RESTARTS} retries; reset this sync's continuation state before retrying.`
    )
  }
  return current + 1
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Readwise sync state has an invalid ${label}.`)
  }
  return value as number
}

function digestHex(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new Error(`Readwise sync state has an invalid ${label}.`)
  }
  return value
}

export function inventoryDigest(
  value: unknown,
  label: string
): InventoryDigest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Readwise sync state has an invalid ${label}.`)
  }
  const digest = value as Partial<InventoryDigest>
  const count = nonNegativeInteger(digest.count, `${label} count`)
  if (count > MAX_REPLACEMENT_RECORDS) {
    throw new Error(`Readwise sync state has an oversized ${label}.`)
  }
  return {
    count,
    xor: digestHex(digest.xor, `${label} xor`),
    sum: digestHex(digest.sum, `${label} sum`),
  }
}

function parsedInventory(
  value: unknown,
  label: string
): ActiveInventory | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Readwise sync state has an invalid ${label}.`)
  }
  const snapshot = value as Partial<InventorySnapshot>
  const providerCount = nonNegativeInteger(
    snapshot.providerCount,
    `${label} provider count`
  )
  const providerCountUnit = snapshot.providerCountUnit
  if (
    providerCountUnit !== undefined &&
    providerCountUnit !== "raw" &&
    providerCountUnit !== "provider-items" &&
    providerCountUnit !== "both"
  ) {
    throw new Error(
      `Readwise sync state has an invalid ${label} provider count unit.`
    )
  }
  const raw = inventoryDigest(snapshot.raw, `${label} raw inventory`)
  const uncoveredRawCount = nonNegativeInteger(
    snapshot.uncoveredRawCount,
    `${label} uncovered raw count`
  )
  if (uncoveredRawCount > raw.count) {
    throw new Error(
      `Readwise sync state has an invalid ${label} uncovered raw count.`
    )
  }
  return {
    providerCount,
    raw,
    output: inventoryDigest(snapshot.output, `${label} output inventory`),
    providerItems: inventoryDigest(
      snapshot.providerItems,
      `${label} provider-item inventory`
    ),
    uncoveredRawCount,
    ...(providerCountUnit ? { providerCountUnit } : {}),
  }
}

function completedCountUnit(
  inventory: ActiveInventory,
  label: string,
  countMode: ProviderCountMode
): ProviderCountUnit {
  const rawMatches = inventory.raw.count === inventory.providerCount
  if (countMode === "exact") {
    if (!rawMatches) {
      throw new ReplacementInstabilityError(
        `Readwise ${label} replacement ended before its count was reached.`
      )
    }
    return "raw"
  }

  const providerItemsMatch =
    inventory.providerItems.count === inventory.providerCount
  if (!rawMatches && !providerItemsMatch) {
    throw new ReplacementInstabilityError(
      `Readwise ${label} count matched neither source containers nor nested highlights.`
    )
  }
  if (providerItemsMatch && inventory.uncoveredRawCount > 0) {
    throw new Error(
      `Readwise ${label} cannot prove completeness because its highlight-based count does not cover ${inventory.uncoveredRawCount} empty source container(s).`
    )
  }
  return rawMatches ? (providerItemsMatch ? "both" : "raw") : "provider-items"
}

export function inventorySnapshot(
  value: unknown,
  label: string,
  countMode: ProviderCountMode = "exact"
): InventorySnapshot | undefined {
  const snapshot = parsedInventory(value, label)
  if (!snapshot) return undefined
  const providerCountUnit = completedCountUnit(snapshot, label, countMode)
  if (snapshot.providerCountUnit !== providerCountUnit) {
    throw new Error(
      `Readwise sync state has an inconsistent ${label} provider count unit.`
    )
  }
  return { ...snapshot, providerCountUnit }
}

function activeInventory(
  value: unknown,
  label: string,
  countMode: ProviderCountMode
): ActiveInventory | undefined {
  const active = parsedInventory(value, label)
  if (active?.providerCountUnit !== undefined) {
    throw new Error(`Readwise sync state has a completed ${label} in progress.`)
  }
  if (
    active &&
    countMode === "exact" &&
    active.raw.count > active.providerCount
  ) {
    throw new Error(`Readwise sync state has an invalid ${label}.`)
  }
  return active
}

export function emptyInventoryDigest(): InventoryDigest {
  return { count: 0, xor: ZERO_DIGEST, sum: ZERO_DIGEST }
}

function addToDigest(
  current: InventoryDigest,
  identities: InventoryIdentity[]
): InventoryDigest {
  const count = current.count + identities.length
  if (!Number.isSafeInteger(count) || count > MAX_REPLACEMENT_RECORDS) {
    throw new Error("Readwise replacement inventory exceeded its safe bound.")
  }
  let xor = BigInt(`0x${current.xor}`)
  let sum = BigInt(`0x${current.sum}`)
  for (const identity of identities) {
    const hex = createHash("sha256")
      .update(identity.namespace)
      .update("\0")
      .update(identity.value)
      .digest("hex")
    const number = BigInt(`0x${hex}`)
    xor ^= number
    sum = (sum + number) % DIGEST_MODULUS
  }
  return {
    count,
    xor: xor.toString(16).padStart(64, "0"),
    sum: sum.toString(16).padStart(64, "0"),
  }
}

function advanceInventory(
  current: ActiveInventory | undefined,
  providerCount: number,
  rawIdentities: InventoryIdentity[],
  outputIdentities: InventoryIdentity[],
  providerItemIdentities: InventoryIdentity[],
  uncoveredRawCount: number,
  label: string,
  countMode: ProviderCountMode
): ActiveInventory {
  if (!Number.isSafeInteger(providerCount) || providerCount < 0) {
    throw new Error(`Readwise ${label} returned an invalid count.`)
  }
  const active = current
    ? {
        providerCount: current.providerCount,
        raw: inventoryDigest(current.raw, `${label} raw inventory`),
        output: inventoryDigest(current.output, `${label} output inventory`),
        providerItems: inventoryDigest(
          current.providerItems,
          `${label} provider-item inventory`
        ),
        uncoveredRawCount: nonNegativeInteger(
          current.uncoveredRawCount,
          `${label} uncovered raw count`
        ),
      }
    : {
        providerCount,
        raw: emptyInventoryDigest(),
        output: emptyInventoryDigest(),
        providerItems: emptyInventoryDigest(),
        uncoveredRawCount: 0,
      }
  if (active.providerCount !== providerCount) {
    throw new ReplacementInstabilityError(
      `Readwise ${label} count changed during replacement.`
    )
  }
  const raw = addToDigest(active.raw, rawIdentities)
  if (countMode === "exact" && raw.count > providerCount) {
    throw new ReplacementInstabilityError(
      `Readwise ${label} returned more records than its count.`
    )
  }
  const nextUncoveredRawCount = active.uncoveredRawCount + uncoveredRawCount
  if (
    !Number.isSafeInteger(uncoveredRawCount) ||
    uncoveredRawCount < 0 ||
    !Number.isSafeInteger(nextUncoveredRawCount) ||
    nextUncoveredRawCount > raw.count
  ) {
    throw new Error(`Readwise ${label} has an invalid uncovered raw count.`)
  }
  return {
    providerCount,
    raw,
    output: addToDigest(active.output, outputIdentities),
    providerItems: addToDigest(active.providerItems, providerItemIdentities),
    uncoveredRawCount: nextUncoveredRawCount,
  }
}

function bloomPositions(identity: InventoryIdentity): number[] {
  const digest = createHash("sha256")
    .update(identity.namespace)
    .update("\0")
    .update(identity.value)
    .digest()
  const first = digest.readBigUInt64BE(0)
  const second = digest.readBigUInt64BE(8) | 1n
  const bitCount = BigInt(IDENTITY_BLOOM_BYTES * 8)
  return Array.from({ length: IDENTITY_BLOOM_HASHES }, (_, index) =>
    Number((first + BigInt(index) * second) % bitCount)
  )
}

function decodedIdentityBloom(state: IdentityGuardState | undefined): {
  bytes: Buffer
  count: number
} {
  const encoded = state?.identityBloom
  const declaredCount = state?.identityCount
  if (encoded === undefined && declaredCount === undefined) {
    return { bytes: Buffer.alloc(IDENTITY_BLOOM_BYTES), count: 0 }
  }
  if (
    typeof encoded !== "string" ||
    !encoded ||
    !Number.isSafeInteger(declaredCount) ||
    (declaredCount as number) < 1 ||
    (declaredCount as number) > MAX_REPLACEMENT_IDENTITIES
  ) {
    throw new Error("Readwise sync state has an invalid identity guard.")
  }
  const bytes = Buffer.from(encoded, "base64url")
  if (
    bytes.toString("base64url") !== encoded ||
    bytes.length !== IDENTITY_BLOOM_BYTES
  ) {
    throw new Error("Readwise sync state has an invalid identity guard.")
  }
  return { bytes, count: declaredCount as number }
}

function bloomContains(bytes: Buffer, identity: InventoryIdentity): boolean {
  return bloomPositions(identity).every((position) => {
    const byte = Math.floor(position / 8)
    const bit = position % 8
    return (bytes[byte] & (1 << bit)) !== 0
  })
}

function appendIdentityBloom(
  state: IdentityGuardState | undefined,
  identities: InventoryIdentity[],
  label: string,
  conflictIdentities: InventoryIdentity[][] = []
): IdentityGuardState {
  const decoded = decodedIdentityBloom(state)
  if (decoded.count + identities.length > MAX_REPLACEMENT_IDENTITIES) {
    throw new Error(
      `Readwise ${label} exceeded ${MAX_REPLACEMENT_IDENTITIES} bounded uniqueness checks for ${MAX_REPLACEMENT_RECORDS} supported records.`
    )
  }
  if (
    conflictIdentities.length > 0 &&
    conflictIdentities.length !== identities.length
  ) {
    throw new Error(`Readwise ${label} has an invalid identity guard plan.`)
  }
  for (const [index, identity] of identities.entries()) {
    const positions = bloomPositions(identity)
    if (
      bloomContains(decoded.bytes, identity) ||
      (conflictIdentities[index] ?? []).some((candidate) =>
        bloomContains(decoded.bytes, candidate)
      )
    ) {
      throw new ReplacementInstabilityError(
        `Readwise ${label} repeated an identity during replacement.`
      )
    }
    for (const position of positions) {
      const byte = Math.floor(position / 8)
      const bit = position % 8
      decoded.bytes[byte] |= 1 << bit
    }
  }
  const count = decoded.count + identities.length
  if (count === 0) return {}
  return {
    identityBloom: decoded.bytes.toString("base64url"),
    identityCount: count,
  }
}

export function advanceGuardedInventory(
  current: ActiveInventory | undefined,
  guardState: IdentityGuardState | undefined,
  providerCount: number,
  rawIdentities: InventoryIdentity[],
  outputIdentities: InventoryIdentity[],
  label: string,
  options: {
    countMode?: ProviderCountMode
    guardIdentities?: InventoryIdentity[]
    guardConflictIdentities?: InventoryIdentity[][]
    providerItemIdentities?: InventoryIdentity[]
    uncoveredRawCount?: number
  } = {}
): { active: ActiveInventory; guard: IdentityGuardState } {
  const countMode = options.countMode ?? "exact"
  if (current === undefined && providerCount > MAX_REPLACEMENT_RECORDS) {
    throw new Error(
      `Readwise ${label} count cannot fit in bounded replacement state.`
    )
  }
  const identities = options.guardIdentities ?? [
    ...rawIdentities,
    ...outputIdentities,
  ]
  return {
    active: advanceInventory(
      current,
      providerCount,
      rawIdentities,
      outputIdentities,
      options.providerItemIdentities ?? rawIdentities,
      options.uncoveredRawCount ?? 0,
      label,
      countMode
    ),
    guard: appendIdentityBloom(
      guardState,
      identities,
      label,
      options.guardConflictIdentities
    ),
  }
}

// A final Reader traversal is compared to the already duplicate-guarded
// collection traversal before completion. It therefore needs a digest but no
// second copy of the membership guard in continuation state.
export function advanceMatchingInventory(
  current: ActiveInventory | undefined,
  providerCount: number,
  rawIdentities: InventoryIdentity[],
  outputIdentities: InventoryIdentity[],
  label: string,
  countMode: ProviderCountMode = "exact",
  options: {
    providerItemIdentities?: InventoryIdentity[]
    uncoveredRawCount?: number
  } = {}
): ActiveInventory {
  return advanceInventory(
    current,
    providerCount,
    rawIdentities,
    outputIdentities,
    options.providerItemIdentities ?? rawIdentities,
    options.uncoveredRawCount ?? 0,
    label,
    countMode
  )
}

export function assertInventoryCanContinue(
  active: ActiveInventory,
  label: string,
  countMode: ProviderCountMode = "exact"
) {
  if (countMode === "exact" && active.raw.count >= active.providerCount) {
    throw new ReplacementInstabilityError(
      `Readwise ${label} returned a continuation cursor after its count was reached.`
    )
  }
}

export function completeInventory(
  value: ActiveInventory,
  label: string,
  countMode: ProviderCountMode = "exact"
): InventorySnapshot {
  const snapshot = parsedInventory(value, label)
  if (!snapshot) throw new Error(`Readwise ${label} inventory is missing.`)
  return {
    ...snapshot,
    providerCountUnit: completedCountUnit(snapshot, label, countMode),
  }
}

export function inventoriesMatch(
  left: InventorySnapshot,
  right: InventorySnapshot
): boolean {
  return (
    left.providerCount === right.providerCount &&
    left.providerCountUnit === right.providerCountUnit &&
    left.raw.count === right.raw.count &&
    left.raw.xor === right.raw.xor &&
    left.raw.sum === right.raw.sum &&
    left.output.count === right.output.count &&
    left.output.xor === right.output.xor &&
    left.output.sum === right.output.sum &&
    left.providerItems.count === right.providerItems.count &&
    left.providerItems.xor === right.providerItems.xor &&
    left.providerItems.sum === right.providerItems.sum &&
    left.uncoveredRawCount === right.uncoveredRawCount
  )
}

export function hasIdentity(
  state: IdentityGuardState | undefined,
  identity: InventoryIdentity
): boolean {
  return bloomContains(decodedIdentityBloom(state).bytes, identity)
}

export function syncStateSize(state: unknown): number {
  return textEncoder.encode(JSON.stringify(state)).byteLength
}

export function boundedSyncState<T>(state: T, resource: string): T {
  const bytes = syncStateSize(state)
  if (bytes > MAX_SAFE_SYNC_STATE_BYTES) {
    throw new Error(
      `Readwise ${resource} continuation state exceeded the 240 KiB safety budget (${Math.ceil(
        bytes / 1_024
      )} KiB).`
    )
  }
  return state
}

function validateCursorAndActive(
  state: CursorGuardState & { active?: ActiveInventory },
  label: string,
  countMode: ProviderCountMode
) {
  const cursor = validPageCursor(state.pageCursor)
  decodedCursorFingerprints(state, MAX_REPLACEMENT_CURSOR_PAGES)
  const active = activeInventory(
    state.active,
    `${label} active inventory`,
    countMode
  )
  if ((cursor === undefined) !== (active === undefined)) {
    throw new Error(
      `Readwise ${label} continuation state must pair its cursor and active inventory.`
    )
  }
}

export function validateReconciliationState(
  state: ReconciliationSyncState | undefined
): void {
  validVersion(state)
  if (!state) return
  boundedSyncState(state, "highlight reconciliation")
  validCredentialFingerprint(
    state.credentialFingerprint,
    "highlight reconciliation"
  )
  const pass = reconciliationPass(state.pass)
  reconciliationRestartCount(state.restartCount)
  validateCursorAndActive(state, "highlight reconciliation", "export")
  decodedIdentityBloom(state)
  const baseline = inventorySnapshot(
    state.baseline,
    "baseline inventory",
    "export"
  )
  if ((pass === "confirm" || pass === "emit") && !baseline) {
    throw new Error(
      "Readwise confirmation state is missing its baseline inventory."
    )
  }
  if (pass === "observe" && baseline) {
    throw new Error(
      "Readwise observation state cannot contain a baseline inventory."
    )
  }
}

export function validateSourcesReconciliationState(
  state: SourcesReconciliationSyncState | undefined
): void {
  validVersion(state)
  if (!state) return
  boundedSyncState(state, "source reconciliation")
  validCredentialFingerprint(
    state.credentialFingerprint,
    "source reconciliation"
  )
  const pass = reconciliationPass(state.pass)
  const currentPhase = sourcesReconciliationPhase(state.phase)
  reconciliationRestartCount(state.restartCount)
  validateCursorAndActive(
    state,
    "source reconciliation",
    currentPhase === "readwise" ? "export" : "exact"
  )
  decodedIdentityBloom(state)
  const baselineReadwise = inventorySnapshot(
    state.baselineReadwise,
    "Readwise baseline inventory",
    "export"
  )
  const baselineReader = inventorySnapshot(
    state.baselineReader,
    "Reader baseline inventory"
  )
  const collectedReader = inventorySnapshot(
    state.collectedReader,
    "collected Reader inventory"
  )
  const completedReadwise = inventorySnapshot(
    state.completedReadwise,
    "completed Readwise inventory",
    "export"
  )

  if (
    (pass === "confirm" || pass === "emit") &&
    (!baselineReadwise || !baselineReader)
  ) {
    throw new Error(
      "Readwise source confirmation state is missing baseline inventories."
    )
  }
  if (pass === "observe" && (baselineReadwise || baselineReader)) {
    throw new Error(
      "Readwise source observation state cannot contain baseline inventories."
    )
  }
  if (currentPhase === "collect-reader") {
    if (collectedReader || completedReadwise) {
      throw new Error(
        "Readwise source collection state contains a later phase inventory."
      )
    }
  } else if (!collectedReader) {
    throw new Error(
      "Readwise source reconciliation is missing its collected Reader inventory."
    )
  }
  if (currentPhase === "readwise" && completedReadwise) {
    throw new Error(
      "Readwise source Export state contains a later phase inventory."
    )
  }
  if (currentPhase === "reader" && !completedReadwise) {
    throw new Error(
      "Readwise source finalization is missing its Export inventory."
    )
  }
}

export function reconciliationCursor(
  state: ReconciliationSyncState | undefined
): string | undefined {
  validateReconciliationState(state)
  return validPageCursor(state?.pageCursor)
}
