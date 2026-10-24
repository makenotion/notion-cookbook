// Typed, read-only clients for Reader documents, Readwise books, and Readwise
// highlight export. Each method fetches exactly one provider page; sync
// executors own pagination and durable checkpoint transitions.

import { createHash } from "node:crypto"

import { RateLimitError } from "@notionhq/workers"

export const READER_PAGE_SIZE = 100
export const READWISE_BOOK_PAGE_SIZE = 1_000
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
  note: string | null
  color: string | null
  highlighted_at: string | null
  updated_at: string | null
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
  source: string
  summary: string | null
  external_id: string | null
  highlights: ReadwiseHighlight[]
}

export type ReadwiseBook = {
  id: string
  title: string | null
  author: string | null
  category: string | null
  source: string
  num_highlights: number
  updated: string
  tags: ReadwiseTag[]
  document_note: string | null
  highlights_url: string | null
  source_url: string | null
}

export type ReaderDocumentPage = {
  documents: ReaderDocument[]
  nextPageCursor: string | undefined
}

export type ReadwiseExportPage = {
  sources: ReadwiseSource[]
  nextPageCursor: string | undefined
}

export type ReadwiseBookPage = {
  books: ReadwiseBook[]
  count: number
  nextPage: number | undefined
}

export type ReadwiseClient = {
  credentialFingerprint(): string
  listReaderDocuments(options: {
    updatedAfter?: string
    pageCursor?: string
  }): Promise<ReaderDocumentPage>
  listReadwiseBooks(options: {
    updatedAfter?: string
    updatedBefore?: string
    page?: number
  }): Promise<ReadwiseBookPage>
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

export function credentialFingerprintForToken(token: string): string {
  const normalized = token.trim()
  if (!normalized) throw new Error("READWISE_ACCESS_TOKEN is not set.")
  return createHash("sha256")
    .update("notion-readwise-worker\0")
    .update(normalized)
    .digest("hex")
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

function optionalNullableString(value: unknown, label: string): string | null {
  return value === undefined ? null : nullableString(value, label)
}

function nullableNumber(value: unknown, label: string): number | null {
  if (value === null) return null
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Readwise ${label} must be a finite number or null.`)
  }
  return value
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Readwise ${label} must be a non-negative integer.`)
  }
  return Number(value)
}

function nullableDate(value: unknown, label: string): string | null {
  const date = nullableString(value, label)
  if (date !== null && (!date.trim() || !Number.isFinite(Date.parse(date)))) {
    throw new Error(`Readwise ${label} must be a valid date or null.`)
  }
  return date
}

function requiredDate(value: unknown, label: string): string {
  const date = requiredString(value, label)
  if (!Number.isFinite(Date.parse(date))) {
    throw new Error(`Readwise ${label} must be a valid date.`)
  }
  return date
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

function ignoredReaderDocument(
  id: string,
  parentId: string | null,
  location: string | null
): ReaderDocument {
  return {
    id,
    url: null,
    source_url: null,
    title: null,
    author: null,
    category: null,
    location,
    tags: {},
    site_name: null,
    reading_time: null,
    updated_at: null,
    published_date: null,
    notes: null,
    summary: null,
    parent_id: parentId,
    reading_progress: null,
    last_opened_at: null,
    saved_at: null,
  }
}

function parseReaderDocument(value: unknown): ReaderDocument {
  const item = record(value, "Reader document")
  const id = stringIdentifier(item.id, "Reader document")
  const parentId = nullableStringIdentifier(item.parent_id, "Reader parent_id")

  // Reader returns nested annotations through the same endpoint. parent_id is
  // enough to exclude them, so unrelated metadata cannot strand the archive.
  if (parentId !== null) return ignoredReaderDocument(id, parentId, null)

  const location = nullableString(item.location, "Reader document location")
  // Feed items are high-volume and intentionally excluded. Validate only their
  // scope fields for the same reason.
  if (location?.trim().toLowerCase() === "feed") {
    return ignoredReaderDocument(id, null, location)
  }

  return {
    id,
    url: nullableString(item.url, "Reader document url"),
    source_url: nullableString(item.source_url, "Reader document source_url"),
    title: nullableString(item.title, "Reader document title"),
    author: nullableString(item.author, "Reader document author"),
    category: nullableString(item.category, "Reader document category"),
    location,
    tags: readerTags(item.tags, "Reader document tags"),
    site_name: nullableString(item.site_name, "Reader document site_name"),
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
    parent_id: parentId,
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

function parseHighlight(
  value: unknown,
  parentDeleted = false
): ReadwiseHighlight {
  const item = record(value, "highlight")
  const id = numericIdentifier(item.id, "highlight")
  const isDeleted =
    parentDeleted && item.is_deleted === undefined
      ? false
      : requiredBoolean(item.is_deleted, "highlight is_deleted")
  if (parentDeleted || isDeleted) {
    return {
      id,
      is_deleted: isDeleted,
      text: optionalNullableString(item.text, "highlight text"),
      note: null,
      color: null,
      highlighted_at: null,
      updated_at: null,
      tags: [],
      is_favorite: false,
      is_discard: false,
      readwise_url: null,
    }
  }

  return {
    id,
    is_deleted: false,
    text: nullableString(item.text, "highlight text"),
    note: nullableString(item.note, "highlight note"),
    color: nullableString(item.color, "highlight color"),
    highlighted_at: nullableDate(
      item.highlighted_at,
      "highlight highlighted_at"
    ),
    updated_at: nullableDate(item.updated_at, "highlight updated_at"),
    tags: tags(item.tags, "highlight tags"),
    is_favorite: requiredBoolean(item.is_favorite, "highlight is_favorite"),
    is_discard: requiredBoolean(item.is_discard, "highlight is_discard"),
    readwise_url: nullableString(item.readwise_url, "highlight readwise_url"),
  }
}

function parseSource(value: unknown): ReadwiseSource {
  const item = record(value, "source")
  const userBookId = numericIdentifier(item.user_book_id, "source")
  const isDeleted = requiredBoolean(item.is_deleted, "source is_deleted")
  const source = requiredString(item.source, "source source")
  const externalId = nullableString(item.external_id, "source external_id")
  if (isDeleted) {
    const sourceHighlights =
      item.highlights === undefined
        ? []
        : array(item.highlights, "source highlights").map((highlight) =>
            parseHighlight(highlight, true)
          )
    return {
      user_book_id: userBookId,
      is_deleted: true,
      title: optionalNullableString(item.title, "source title"),
      readable_title: optionalNullableString(
        item.readable_title,
        "source readable_title"
      ),
      source,
      summary: null,
      external_id: externalId,
      highlights: sourceHighlights,
    }
  }

  return {
    user_book_id: userBookId,
    is_deleted: false,
    title: nullableString(item.title, "source title"),
    readable_title: nullableString(
      item.readable_title,
      "source readable_title"
    ),
    source,
    summary: nullableString(item.summary, "source summary"),
    external_id: externalId,
    highlights: array(item.highlights, "source highlights").map((highlight) =>
      parseHighlight(highlight)
    ),
  }
}

function parseBook(value: unknown): ReadwiseBook {
  const item = record(value, "book")
  return {
    id: numericIdentifier(item.id, "book"),
    title: optionalNullableString(item.title, "book title"),
    author: optionalNullableString(item.author, "book author"),
    category: optionalNullableString(item.category, "book category"),
    source: requiredString(item.source, "book source"),
    num_highlights: nonnegativeInteger(
      item.num_highlights,
      "book num_highlights"
    ),
    updated: requiredDate(item.updated, "book updated"),
    tags: tags(item.tags, "book tags"),
    document_note: optionalNullableString(
      item.document_note,
      "book document_note"
    ),
    highlights_url: optionalNullableString(
      item.highlights_url,
      "book highlights_url"
    ),
    source_url: optionalNullableString(item.source_url, "book source_url"),
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

function positivePage(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`Readwise ${label} must be a positive page number.`)
  }
  return Number(value)
}

function parseNextBookPage(value: unknown): number | undefined {
  if (value === null) return undefined
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      "Readwise book page has an invalid next URL; expected null or a Readwise URL."
    )
  }

  let next: URL
  try {
    next = new URL(value)
  } catch {
    throw new Error("Readwise book page returned an invalid next URL.")
  }
  if (
    next.protocol !== "https:" ||
    next.hostname !== "readwise.io" ||
    next.pathname !== "/api/v2/books/"
  ) {
    throw new Error("Readwise book page returned an unexpected next URL.")
  }

  return positivePage(Number(next.searchParams.get("page")), "next page")
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
    const token = requiredToken()
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
      return credentialFingerprintForToken(requiredToken())
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
        nextPageCursor: parseCursor(
          body.nextPageCursor,
          "Reader document page"
        ),
      }
    },

    async listReadwiseBooks({ updatedAfter, updatedBefore, page = 1 }) {
      const currentPage = positivePage(page, "book page")
      const url = new URL("https://readwise.io/api/v2/books/")
      url.searchParams.set("page_size", String(READWISE_BOOK_PAGE_SIZE))
      url.searchParams.set("page", String(currentPage))
      if (updatedAfter) url.searchParams.set("updated__gt", updatedAfter)
      if (updatedBefore) url.searchParams.set("updated__lt", updatedBefore)

      const body = await fetchObject(url, "listing Readwise books")
      return {
        books: array(body.results, "book results").map(parseBook),
        count: nonnegativeInteger(body.count, "book count"),
        nextPage: parseNextBookPage(body.next),
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
        nextPageCursor: parseCursor(
          body.nextPageCursor,
          "highlight export page"
        ),
      }
    },
  }
}
