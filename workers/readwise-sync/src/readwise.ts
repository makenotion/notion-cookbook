// Typed, read-only clients for Reader's document list and Readwise's highlight
// export. Each method fetches exactly one provider page; sync executors own the
// opaque pageCursor and durable checkpoint transitions.

import { RateLimitError } from "@notionhq/workers"

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
  source: string | null
  category: string | null
  location: string | null
  tags: unknown
  site_name: string | null
  word_count: number | null
  reading_time: string | null
  listening_time: string | null
  created_at: string | null
  updated_at: string | null
  published_date: string | null
  notes: string | null
  summary: string | null
  image_url: string | null
  parent_id: string | null
  reading_progress: number | null
  first_opened_at: string | null
  last_opened_at: string | null
  saved_at: string | null
  last_moved_at: string | null
}

export type ReadwiseTag = {
  id: string | null
  name: string | null
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
  end_location: number | null
  url: string | null
  book_id: string | null
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
  source: string | null
  cover_image_url: string | null
  unique_url: string | null
  book_tags: ReadwiseTag[]
  category: string | null
  document_note: string | null
  summary: string | null
  readwise_url: string | null
  source_url: string | null
  external_id: string | null
  asin: string | null
  highlights: ReadwiseHighlight[]
}

export type ReaderDocumentPage = {
  documents: ReaderDocument[]
  nextPageCursor: string | undefined
}

export type ReadwiseExportPage = {
  sources: ReadwiseSource[]
  nextPageCursor: string | undefined
}

export type ReadwiseClient = {
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

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function boolean(value: unknown): boolean {
  return value === true
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Readwise ${label} must be a boolean.`)
  }
  return value
}

function identifier(value: unknown, label: string): string {
  const id =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : ""
  if (!id || id.length > 512) {
    throw new Error(`Readwise ${label} is missing a valid stable id.`)
  }
  return id
}

function tags(value: unknown, label: string): ReadwiseTag[] {
  if (value == null) return []
  return array(value, label).map((candidate) => {
    const item = record(candidate, `${label} item`)
    const rawId = item.id
    return {
      id:
        typeof rawId === "string" ||
        (typeof rawId === "number" && Number.isSafeInteger(rawId))
          ? String(rawId)
          : null,
      name: nullableString(item.name),
    }
  })
}

function parseReaderDocument(value: unknown): ReaderDocument {
  const item = record(value, "Reader document")
  return {
    id: identifier(item.id, "Reader document"),
    url: nullableString(item.url),
    source_url: nullableString(item.source_url),
    title: nullableString(item.title),
    author: nullableString(item.author),
    source: nullableString(item.source),
    category: nullableString(item.category),
    location: nullableString(item.location),
    tags: item.tags,
    site_name: nullableString(item.site_name),
    word_count: nullableNumber(item.word_count),
    reading_time: nullableString(item.reading_time),
    listening_time: nullableString(item.listening_time),
    created_at: nullableString(item.created_at),
    updated_at: nullableString(item.updated_at),
    published_date: nullableString(item.published_date),
    notes: nullableString(item.notes),
    summary: nullableString(item.summary),
    image_url: nullableString(item.image_url),
    parent_id: nullableString(item.parent_id),
    reading_progress: nullableNumber(item.reading_progress),
    first_opened_at: nullableString(item.first_opened_at),
    last_opened_at: nullableString(item.last_opened_at),
    saved_at: nullableString(item.saved_at),
    last_moved_at: nullableString(item.last_moved_at),
  }
}

function parseHighlight(value: unknown): ReadwiseHighlight {
  const item = record(value, "highlight")
  return {
    id: identifier(item.id, "highlight"),
    is_deleted: requiredBoolean(item.is_deleted, "highlight is_deleted"),
    text: nullableString(item.text),
    location: nullableNumber(item.location),
    location_type: nullableString(item.location_type),
    note: nullableString(item.note),
    color: nullableString(item.color),
    highlighted_at: nullableString(item.highlighted_at),
    created_at: nullableString(item.created_at),
    updated_at: nullableString(item.updated_at ?? item.updated),
    external_id: nullableString(item.external_id),
    end_location: nullableNumber(item.end_location),
    url: nullableString(item.url),
    book_id:
      item.book_id == null ? null : identifier(item.book_id, "highlight book"),
    tags: tags(item.tags, "highlight tags"),
    is_favorite: boolean(item.is_favorite),
    is_discard: boolean(item.is_discard),
    readwise_url: nullableString(item.readwise_url),
  }
}

function parseSource(value: unknown): ReadwiseSource {
  const item = record(value, "source")
  return {
    user_book_id: identifier(item.user_book_id, "source"),
    is_deleted: requiredBoolean(item.is_deleted, "source is_deleted"),
    title: nullableString(item.title),
    readable_title: nullableString(item.readable_title),
    author: nullableString(item.author),
    source: nullableString(item.source),
    cover_image_url: nullableString(item.cover_image_url),
    unique_url: nullableString(item.unique_url),
    book_tags: tags(item.book_tags, "source tags"),
    category: nullableString(item.category),
    document_note: nullableString(item.document_note),
    summary: nullableString(item.summary),
    readwise_url: nullableString(item.readwise_url),
    source_url: nullableString(item.source_url),
    external_id: nullableString(item.external_id),
    asin: nullableString(item.asin),
    highlights: array(item.highlights ?? [], "source highlights").map(
      parseHighlight
    ),
  }
}

function parseCursor(value: unknown, label: string): string | undefined {
  if (value == null) return undefined
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Readwise ${label} has an invalid nextPageCursor.`)
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
