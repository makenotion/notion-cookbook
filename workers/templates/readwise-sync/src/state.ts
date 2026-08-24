// Incremental state is plain JSON. A cycle pins one updatedAfter/checkpoint
// window until its traversal finishes, then overlaps the next by five minutes.
// Sources keep the same window while moving through Books, Export, and Reader.

import { createHash } from "node:crypto"

export const INITIAL_UPDATED_AFTER = new Date(0).toISOString()
export const CONSISTENCY_BUFFER_MS = 60_000
export const WATERMARK_OVERLAP_MS = 5 * 60_000
export const MAX_CURSOR_PAGES = 10_000
export const MAX_CURSOR_LENGTH = 4_096
export const MAX_SAFE_SYNC_STATE_BYTES = 240 * 1_024
export const MAX_PAGINATION_RESTARTS = 3

const CURSOR_FINGERPRINT_BYTES = 12
const CREDENTIAL_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/
const textEncoder = new TextEncoder()

export type SyncPhase = "books" | "reader" | "readwise"

export type CursorGuardState = {
  pageCursor?: string
  cursorFingerprints?: string
  pageCount?: number
}

export type IncrementalSyncState = CursorGuardState & {
  credentialFingerprint: string
  updatedAfter: string
  checkpoint?: string
  paginationRestartCount?: number
}

export type SourcesIncrementalSyncState = IncrementalSyncState & {
  phase?: SyncPhase
  booksExpectedCount?: number
}

export class PaginationInstabilityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PaginationInstabilityError"
  }
}

function isoDateTime(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Readwise sync state has an invalid ${label}.`)
  }
  return value
}

export function isCredentialFingerprint(value: unknown): value is string {
  return typeof value === "string" && CREDENTIAL_FINGERPRINT_PATTERN.test(value)
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
      `Readwise credentials changed for ${resource}. Restore the configured token or deploy a separate Worker for the new token.`
    )
  }
  return current
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

function decodedCursorFingerprints(state: CursorGuardState | undefined): {
  bytes: Buffer
  fingerprints: Set<string>
  count: number
} {
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
    (declaredCount as number) > MAX_CURSOR_PAGES
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

  const currentFingerprint = cursorFingerprint(cursor).toString("base64url")
  const lastFingerprint = bytes
    .subarray(bytes.length - CURSOR_FINGERPRINT_BYTES)
    .toString("base64url")
  if (lastFingerprint !== currentFingerprint) {
    throw new Error("Readwise sync state does not guard its current cursor.")
  }
  return { bytes, fingerprints, count: declaredCount as number }
}

export function paginationRestartCount(value: unknown): number {
  if (value === undefined) return 0
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_PAGINATION_RESTARTS
  ) {
    throw new Error(
      "Readwise sync state has an invalid pagination restart count."
    )
  }
  return value as number
}

export function nextPaginationRestartCount(
  value: unknown,
  resource: string
): number {
  const current = paginationRestartCount(value)
  if (current >= MAX_PAGINATION_RESTARTS) {
    throw new Error(
      `Readwise ${resource} pagination remained unstable after ${MAX_PAGINATION_RESTARTS} retries; reset this sync's continuation state before retrying.`
    )
  }
  return current + 1
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
  if (state) boundedSyncState(state, "incremental")
  const credentialFingerprint = boundCredentialFingerprint(
    state,
    currentFingerprint,
    "incremental"
  )
  paginationRestartCount(state?.paginationRestartCount)
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
  decodedCursorFingerprints(state)

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
  resource: string
): Required<CursorGuardState> {
  const cursor = validPageCursor(nextPageCursor)
  if (!cursor) {
    throw new Error(`Readwise ${resource} pagination is missing a cursor.`)
  }

  const decoded = decodedCursorFingerprints(state)
  const fingerprint = cursorFingerprint(cursor)
  const encoded = fingerprint.toString("base64url")
  if (decoded.fingerprints.has(encoded)) {
    throw new PaginationInstabilityError(
      `Readwise ${resource} pagination repeated a cursor.`
    )
  }

  const pageCount = decoded.count + 1
  if (pageCount > MAX_CURSOR_PAGES) {
    throw new Error(
      `Readwise ${resource} pagination exceeded ${MAX_CURSOR_PAGES} pages.`
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
  const boundFingerprint = validCredentialFingerprint(
    credentialFingerprint,
    "incremental"
  )
  const parsed = Date.parse(isoDateTime(checkpoint, "checkpoint"))
  return {
    credentialFingerprint: boundFingerprint,
    updatedAfter: new Date(
      Math.max(0, parsed - WATERMARK_OVERLAP_MS)
    ).toISOString(),
  }
}

export function phase(value: unknown): SyncPhase {
  if (value === undefined) return "books"
  if (value !== "books" && value !== "reader" && value !== "readwise") {
    throw new Error("Readwise source sync state has an invalid phase.")
  }
  return value
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
