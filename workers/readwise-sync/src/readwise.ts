// Typed, read-only clients for Reader's document list and Readwise's highlight
// export. Each method fetches exactly one provider page; sync executors own the
// opaque pageCursor and durable checkpoint transitions.

import { RateLimitError } from "@notionhq/workers"

import {
  credentialFingerprintForToken,
  isCredentialFingerprint,
} from "./credential.js"

export const READER_PAGE_SIZE = 100
export const REQUEST_TIMEOUT_MS = 30_000
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const DEFAULT_RETRY_AFTER_SECONDS = 60

export type BeforeRequest = () => Promise<void>

export type ReaderDocument = {
  id: string
  url: string | null
  source_url: string | null
  title: string | null
  author: string | null
  category: string | null
  location: string | null
  tags: Record<string, { name: string }>
  site_name: string | null
  word_count: number | null
  reading_time: string | null
  updated_at: string | null
  published_date: string | null
  notes: string | null
  summary: string | null
  parent_id: string | null
  reading_progress: number | null
  last_opened_at: string | null
  saved_at: string | null
}

export type ReadwiseTag = {
  name: string
}

export type ReadwiseHighlight = {
  id: string
  is_deleted: boolean
  text: string | null
  location: number | null
  location_type: string | null
  note: string | null
  color: string | null
  highlighted_at: string | null
  created_at: string | null
  updated_at: string | null
  external_id: string | null
  url: string | null
  tags: ReadwiseTag[]
  is_favorite: boolean
  is_discard: boolean
  readwise_url: string | null
}

export type ReadwiseSource = {
  user_book_id: string
  is_deleted: boolean
  title: string | null
  readable_title: string | null
  author: string | null
  source: string
  unique_url: string | null
  book_tags: ReadwiseTag[]
  category: string | null
  document_note: string | null
  summary: string | null
  readwise_url: string | null
  source_url: string | null
  external_id: string | null
  highlights: ReadwiseHighlight[]
}

export type ReaderDocumentPage = {
  documents: ReaderDocument[]
  count: number
  nextPageCursor: string | undefined
}

export type ReadwiseExportPage = {
  sources: ReadwiseSource[]
  count: number
  nextPageCursor: string | undefined
}

export type ReadwiseClient = {
  credentialFingerprint(): string
  listReaderDocuments(options: {
    updatedAfter?: string
    pageCursor?: string
  }): Promise<ReaderDocumentPage>
  exportHighlights(options: {
    updatedAfter?: string
    pageCursor?: string
    includeDeleted: boolean
  }): Promise<ReadwiseExportPage>
}

export class ReadwiseApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = "ReadwiseApiError"
  }
}

type Fetch = typeof fetch

function requiredToken(): string {
  const token = process.env.READWISE_ACCESS_TOKEN?.trim()
  if (!token) throw new Error("READWISE_ACCESS_TOKEN is not set.")
  return token
}

function boundCredential(): { token: string; fingerprint: string } {
  const token = requiredToken()
  const fingerprint = credentialFingerprintForToken(token)
  const configured = process.env.READWISE_CREDENTIAL_FINGERPRINT?.trim()
  if (!isCredentialFingerprint(configured)) {
    throw new Error(
      "READWISE_CREDENTIAL_FINGERPRINT is not set to a valid 64-character fingerprint."
    )
  }
  if (configured !== fingerprint) {
    throw new Error(
      "READWISE_ACCESS_TOKEN does not match READWISE_CREDENTIAL_FINGERPRINT."
    )
  }
  return { token, fingerprint }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Readwise ${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Readwise ${label} must be an array.`)
  }
  return value
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Readwise ${label} must be a non-empty string.`)
  }
  return value
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null
  if (typeof value !== "string") {
    throw new Error(`Readwise ${label} must be a string or null.`)
  }
  return value
}

function nullableNumber(value: unknown, label: string): number | null {
  if (value === null) return null
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Readwise ${label} must be a finite number or null.`)
  }
  return value
}

function nullableDate(value: unknown, label: string): string | null {
  const date = nullableString(value, label)
  if (date !== null && (!date.trim() || !Number.isFinite(Date.parse(date)))) {
    throw new Error(`Readwise ${label} must be a valid date or null.`)
  }
  return date
}

function nullableNonNegativeInteger(
  value: unknown,
  label: string
): number | null {
  const number = nullableNumber(value, label)
  if (number !== null && (!Number.isSafeInteger(number) || number < 0)) {
    throw new Error(`Readwise ${label} must be a non-negative integer or null.`)
  }
  return number
}

function nullableProgress(value: unknown, label: string): number | null {
  const number = nullableNumber(value, label)
  if (number !== null && (number < 0 || number > 1)) {
    throw new Error(`Readwise ${label} must be between 0 and 1 or null.`)
  }
  return number
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Readwise ${label} must be a boolean.`)
  }
  return value
}

function stringIdentifier(value: unknown, label: string): string {
  const id = typeof value === "string" ? value.trim() : ""
  if (!id || id.length > 512) {
    throw new Error(`Readwise ${label} is missing a valid stable id.`)
  }
  return id
}

function numericIdentifier(value: unknown, label: string): string {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`Readwise ${label} is missing a valid stable id.`)
  }
  return String(value)
}

function nullableStringIdentifier(
  value: unknown,
  label: string
): string | null {
  if (value === null) return null
  if (typeof value !== "string") {
    throw new Error(`Readwise ${label} must be null or a valid stable id.`)
  }
  const id = value.trim()
  if (!id || id.length > 512) {
    throw new Error(`Readwise ${label} must be null or a valid stable id.`)
  }
  return id
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Readwise ${label} must be a non-negative integer.`)
  }
  return Number(value)
}

function tags(value: unknown, label: string): ReadwiseTag[] {
  return array(value, label).map((candidate) => {
    const item = record(candidate, `${label} item`)
    return {
      name: requiredString(item.name, `${label} item name`),
    }
  })
}

function readerTags(
  value: unknown,
  label: string
): Record<string, { name: string }> {
  const parsed = record(value, label)
  return Object.fromEntries(
    Object.entries(parsed).map(([key, candidate]) => {
      const item = record(candidate, `${label} item`)
      return [key, { name: requiredString(item.name, `${label} item name`) }]
    })
  )
}

function parseReaderDocument(value: unknown): ReaderDocument {
  const item = record(value, "Reader document")
  return {
    id: stringIdentifier(item.id, "Reader document"),
    url: nullableString(item.url, "Reader document url"),
    source_url: nullableString(item.source_url, "Reader document source_url"),
    title: nullableString(item.title, "Reader document title"),
    author: nullableString(item.author, "Reader document author"),
    category: nullableString(item.category, "Reader document category"),
    location: nullableString(item.location, "Reader document location"),
    tags: readerTags(item.tags, "Reader document tags"),
    site_name: nullableString(item.site_name, "Reader document site_name"),
    word_count: nullableNonNegativeInteger(
      item.word_count,
      "Reader document word_count"
    ),
    reading_time: nullableString(
      item.reading_time,
      "Reader document reading_time"
    ),
    updated_at: nullableDate(item.updated_at, "Reader document updated_at"),
    published_date: nullableDate(
      item.published_date,
      "Reader document published_date"
    ),
    notes: nullableString(item.notes, "Reader document notes"),
    summary: nullableString(item.summary, "Reader document summary"),
    parent_id: nullableStringIdentifier(item.parent_id, "Reader parent_id"),
    reading_progress: nullableProgress(
      item.reading_progress,
      "Reader document reading_progress"
    ),
    last_opened_at: nullableDate(
      item.last_opened_at,
      "Reader document last_opened_at"
    ),
    saved_at: nullableDate(item.saved_at, "Reader document saved_at"),
  }
}

function parseHighlight(value: unknown): ReadwiseHighlight {
  const item = record(value, "highlight")
  return {
    id: numericIdentifier(item.id, "highlight"),
    is_deleted: requiredBoolean(item.is_deleted, "highlight is_deleted"),
    text: nullableString(item.text, "highlight text"),
    location: nullableNonNegativeInteger(item.location, "highlight location"),
    location_type: nullableString(
      item.location_type,
      "highlight location_type"
    ),
    note: nullableString(item.note, "highlight note"),
    color: nullableString(item.color, "highlight color"),
    highlighted_at: nullableDate(
      item.highlighted_at,
      "highlight highlighted_at"
    ),
    created_at: nullableDate(item.created_at, "highlight created_at"),
    updated_at: nullableDate(item.updated_at, "highlight updated_at"),
    external_id: nullableString(item.external_id, "highlight external_id"),
    url: nullableString(item.url, "highlight url"),
    tags: tags(item.tags, "highlight tags"),
    is_favorite: requiredBoolean(item.is_favorite, "highlight is_favorite"),
    is_discard: requiredBoolean(item.is_discard, "highlight is_discard"),
    readwise_url: nullableString(item.readwise_url, "highlight readwise_url"),
  }
}

function parseSource(value: unknown): ReadwiseSource {
  const item = record(value, "source")
  return {
    user_book_id: numericIdentifier(item.user_book_id, "source"),
    is_deleted: requiredBoolean(item.is_deleted, "source is_deleted"),
    title: nullableString(item.title, "source title"),
    readable_title: nullableString(
      item.readable_title,
      "source readable_title"
    ),
    author: nullableString(item.author, "source author"),
    source: requiredString(item.source, "source source"),
    unique_url: nullableString(item.unique_url, "source unique_url"),
    book_tags: tags(item.book_tags, "source tags"),
    category: nullableString(item.category, "source category"),
    document_note: nullableString(item.document_note, "source document_note"),
    summary: nullableString(item.summary, "source summary"),
    readwise_url: nullableString(item.readwise_url, "source readwise_url"),
    source_url: nullableString(item.source_url, "source source_url"),
    external_id: nullableString(item.external_id, "source external_id"),
    highlights: array(item.highlights, "source highlights").map(parseHighlight),
  }
}

function parseCursor(value: unknown, label: string): string | undefined {
  if (value === null) return undefined
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `Readwise ${label} has an invalid nextPageCursor; expected null or a non-empty string.`
    )
  }
  return value
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`Readwise returned invalid JSON while ${label}.`)
  }
}

function retryAfterSeconds(response: Response): number {
  const header = response.headers.get("Retry-After")?.trim()
  if (!header) return DEFAULT_RETRY_AFTER_SECONDS

  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds

  const date = Date.parse(header)
  return Number.isFinite(date)
    ? Math.max(0, Math.ceil((date - Date.now()) / 1_000))
    : DEFAULT_RETRY_AFTER_SECONDS
}

function declaredContentLength(response: Response): number | undefined {
  const header = response.headers.get("Content-Length")?.trim()
  if (!header) return undefined
  const value = Number(header)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Readwise returned an invalid Content-Length header.")
  }
  return value
}

async function cancelBody(response: Response) {
  try {
    await response.body?.cancel()
  } catch {
    // The response is already being discarded. Do not mask the safer error.
  }
}

async function boundedResponseText(response: Response, label: string) {
  const declared = declaredContentLength(response)
  if (declared !== undefined && declared > MAX_RESPONSE_BYTES) {
    await cancelBody(response)
    throw new Error(
      `Readwise response exceeded ${MAX_RESPONSE_BYTES} bytes while ${label}.`
    )
  }
  if (!response.body) return ""

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel()
        } catch {
          // The size violation is the actionable error.
        }
        throw new Error(
          `Readwise response exceeded ${MAX_RESPONSE_BYTES} bytes while ${label}.`
        )
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

export function createReadwiseClient(
  beforeRequest: BeforeRequest,
  fetchImpl: Fetch = fetch
): ReadwiseClient {
  async function fetchObject(url: URL, label: string) {
    const { token } = boundCredential()
    await beforeRequest()
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Token ${token}`,
        Accept: "application/json",
        "User-Agent": "notion-cookbook-readwise-sync",
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.status === 429) {
      await cancelBody(response)
      throw new RateLimitError({ retryAfter: retryAfterSeconds(response) })
    }
    if (!response.ok) {
      await cancelBody(response)
      throw new ReadwiseApiError(
        response.status,
        `Readwise API error (${response.status}) while ${label}.`
      )
    }
    const text = await boundedResponseText(response, label)
    return record(parseJson(text, label), `${label} response`)
  }

  return {
    credentialFingerprint() {
      return boundCredential().fingerprint
    },

    async listReaderDocuments({ updatedAfter, pageCursor }) {
      const url = new URL("https://readwise.io/api/v3/list/")
      url.searchParams.set("limit", String(READER_PAGE_SIZE))
      if (updatedAfter) url.searchParams.set("updatedAfter", updatedAfter)
      if (pageCursor) url.searchParams.set("pageCursor", pageCursor)

      const body = await fetchObject(url, "listing Reader documents")
      return {
        documents: array(body.results, "Reader document results").map(
          parseReaderDocument
        ),
        count: nonNegativeInteger(body.count, "Reader document count"),
        nextPageCursor: parseCursor(
          body.nextPageCursor,
          "Reader document page"
        ),
      }
    },

    async exportHighlights({ updatedAfter, pageCursor, includeDeleted }) {
      const url = new URL("https://readwise.io/api/v2/export/")
      if (updatedAfter) url.searchParams.set("updatedAfter", updatedAfter)
      if (pageCursor) url.searchParams.set("pageCursor", pageCursor)
      if (includeDeleted) url.searchParams.set("includeDeleted", "true")

      const body = await fetchObject(url, "exporting Readwise highlights")
      return {
        sources: array(body.results, "highlight export results").map(
          parseSource
        ),
        count: nonNegativeInteger(body.count, "highlight export count"),
        nextPageCursor: parseCursor(
          body.nextPageCursor,
          "highlight export page"
        ),
      }
    },
  }
}
