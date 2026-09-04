import { RateLimitError } from "@notionhq/workers"

const API_BASE_URL = "https://api.raindrop.io"
export const PAGE_SIZE = 50
export const PAGES_PER_SYNC_EXECUTION = 3
export const MAX_PAGINATED_RECORDS = 10_000
export const MAX_COLLECTIONS = 1_000
export const MAX_RESPONSE_BYTES = 10 * 1_024 * 1_024
export const REQUEST_TIMEOUT_MS = 30_000
export const NOTION_URL_LIMIT = 2_000
const MAX_PROVIDER_PAGE = MAX_PAGINATED_RECORDS / PAGE_SIZE

export type BeforeRequest = () => Promise<void>

export type RaindropClientOptions = {
  beforeRequest: BeforeRequest
  fetchImpl?: typeof fetch
  getAccessToken?: () => string
  getExpectedAccountId?: () => number
  requestTimeoutMs?: number
}

export type RaindropType =
  | "link"
  | "article"
  | "image"
  | "video"
  | "document"
  | "audio"

export type RaindropBookmark = {
  _id: number
  title: string
  link: string | undefined
  linkOmitted: boolean
  domain: string
  excerpt: string
  note: string
  type: RaindropType
  tags: string[]
  collection: { $id: number }
  important: boolean
  broken: boolean
  reminderAt?: string
  created: string
  lastUpdate: string
  highlights: unknown[]
  contributor?: {
    id: number
    fullName: string
  }
}

export type RaindropHighlight = {
  _id: string
  raindropRef: number
  text: string
  note: string
  color: RaindropHighlightColor
  title: string
  link: string | undefined
  linkOmitted: boolean
  tags: string[]
  created: string
}

export type RaindropHighlightColor =
  | "blue"
  | "brown"
  | "cyan"
  | "gray"
  | "green"
  | "indigo"
  | "orange"
  | "pink"
  | "purple"
  | "red"
  | "teal"
  | "yellow"

export type BookmarkScope = "active" | "trash"
type CollectionScope = "root" | "child"

export type RaindropAccessLevel = 1 | 2 | 3 | 4

export type RaindropCollection = {
  _id: number
  title: string
  count?: number
  public: boolean
  ownerId?: number
  accessLevel?: RaindropAccessLevel
  shared: boolean
  parentId?: number
  parentAvailable: boolean
  created?: string
  lastUpdate?: string
}

export type RaindropPage<T> = {
  items: T[]
}

export type RaindropPageBatch<T> = {
  items: T[]
  pages: T[][]
}

export type RaindropSession = {
  accountId: number
  fetchCollections(): Promise<RaindropCollection[]>
  fetchBookmarksPage(
    scope: BookmarkScope,
    page: number
  ): Promise<RaindropPage<RaindropBookmark>>
  fetchBookmarksBatch(
    scope: BookmarkScope,
    page: number
  ): Promise<RaindropPageBatch<RaindropBookmark>>
  fetchHighlightsPage(page: number): Promise<RaindropPage<RaindropHighlight>>
  fetchHighlightsBatch(
    page: number
  ): Promise<RaindropPageBatch<RaindropHighlight>>
}

export type RaindropClient = {
  authenticate(): Promise<RaindropSession>
}

export function createRaindropClient(
  options: RaindropClientOptions
): RaindropClient {
  const fetchImpl = options.fetchImpl ?? fetch
  const getAccessToken = options.getAccessToken ?? requireAccessToken
  const getExpectedAccountId =
    options.getExpectedAccountId ?? requireExpectedAccountId
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("Raindrop.io request timeout must be a positive integer.")
  }

  async function request(path: string, accessToken: string): Promise<unknown> {
    await options.beforeRequest()
    const signal = AbortSignal.timeout(requestTimeoutMs)
    let response: Response
    try {
      response = await fetchImpl(new URL(path, API_BASE_URL), {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "notion-cookbook-raindrop-sync",
        },
        redirect: "error",
        signal,
      })
    } catch {
      if (signal.aborted) {
        throw new Error(
          `Raindrop.io API request timed out after ${requestTimeoutMs}ms.`
        )
      }
      throw new Error(
        "Raindrop.io API request failed before a response was received."
      )
    }

    if (response.status === 429) {
      const retryAfter = retryAfterSeconds(response.headers)
      await cancelResponseBody(response)
      throw new RateLimitError({
        retryAfter,
      })
    }
    if (response.status === 401 || response.status === 403) {
      await cancelResponseBody(response)
      throw new Error(
        "Raindrop.io rejected RAINDROP_ACCESS_TOKEN. Create or replace the test token, then retry."
      )
    }
    if (!response.ok) {
      await cancelResponseBody(response)
      throw new Error(`Raindrop.io API request failed (${response.status}).`)
    }

    let responseText: string
    try {
      responseText = await readBoundedResponseText(response)
    } catch (error) {
      if (signal.aborted) {
        throw new Error(
          `Raindrop.io API request timed out after ${requestTimeoutMs}ms.`
        )
      }
      throw error
    }
    try {
      return JSON.parse(responseText) as unknown
    } catch {
      throw new Error("Raindrop.io returned an invalid JSON response.")
    }
  }

  async function fetchCollectionList(
    path: string,
    label: string,
    scope: CollectionScope,
    accessToken: string
  ): Promise<RaindropCollection[]> {
    const payload = responseObject(await request(path, accessToken), label)
    return responseItems(payload, label).map((item, index) =>
      parseCollection(item, `${label}.items[${index}]`, scope)
    )
  }

  async function fetchPageBatch<T>(
    startPage: number,
    fetchPage: (page: number) => Promise<RaindropPage<T>>
  ): Promise<RaindropPageBatch<T>> {
    const pages: T[][] = []
    for (let offset = 0; offset < PAGES_PER_SYNC_EXECUTION; offset += 1) {
      const pageNumber = startPage + offset
      if (pageNumber > MAX_PROVIDER_PAGE) break
      const page = await fetchPage(pageNumber)
      pages.push(page.items)
      if (page.items.length < PAGE_SIZE) break
    }
    return { items: pages.flat(), pages }
  }

  return {
    async authenticate() {
      const accessToken = getAccessToken().trim()
      if (!accessToken) {
        throw new Error("RAINDROP_ACCESS_TOKEN is not set.")
      }
      const expectedAccountId = getExpectedAccountId()
      if (!Number.isSafeInteger(expectedAccountId) || expectedAccountId <= 0) {
        throw new Error(
          "RAINDROP_ACCOUNT_ID must be a positive integer account ID."
        )
      }

      const payload = responseObject(
        await request("/rest/v1/user", accessToken),
        "user"
      )
      const user = objectValue(payload.user, "user.user")
      const accountId = positiveInteger(user._id, "user.user._id")
      if (accountId !== expectedAccountId) {
        throw new Error(
          "Raindrop.io authenticated a different account than RAINDROP_ACCOUNT_ID. Restore a token for the configured account or deploy a separate Worker."
        )
      }

      const fetchBookmarksPage = async (
        scope: BookmarkScope,
        page: number
      ): Promise<RaindropPage<RaindropBookmark>> => {
        const collectionId = scope === "active" ? 0 : -99
        const url = new URL(`/rest/v1/raindrops/${collectionId}`, API_BASE_URL)
        url.searchParams.set("sort", "created")
        url.searchParams.set("perpage", String(PAGE_SIZE))
        url.searchParams.set("page", String(page))
        const bookmarkPayload = responseObject(
          await request(`${url.pathname}${url.search}`, accessToken),
          "bookmarks"
        )
        const items = responseItems(bookmarkPayload, "bookmarks").map(
          (item, index) => parseBookmark(item, `bookmarks.items[${index}]`)
        )
        assertBookmarkScope(items, scope)
        assertPage(items, (item) => String(item._id), "bookmark")
        return { items }
      }

      const fetchHighlightsPage = async (
        page: number
      ): Promise<RaindropPage<RaindropHighlight>> => {
        const url = new URL("/rest/v1/highlights", API_BASE_URL)
        url.searchParams.set("perpage", String(PAGE_SIZE))
        url.searchParams.set("page", String(page))
        const highlightPayload = responseObject(
          await request(`${url.pathname}${url.search}`, accessToken),
          "highlights"
        )
        const items = responseItems(highlightPayload, "highlights").map(
          (item, index) => parseHighlight(item, `highlights.items[${index}]`)
        )
        assertPage(items, (item) => item._id, "highlight")
        return { items }
      }

      return {
        accountId,

        async fetchCollections() {
          const root = await fetchCollectionList(
            "/rest/v1/collections",
            "root collections",
            "root",
            accessToken
          )
          const children = await fetchCollectionList(
            "/rest/v1/collections/childrens",
            "child collections",
            "child",
            accessToken
          )
          const collections: RaindropCollection[] = [
            {
              _id: -1,
              title: "Unsorted",
              public: false,
              shared: false,
              parentAvailable: true,
            },
            {
              _id: -99,
              title: "Trash",
              public: false,
              shared: false,
              parentAvailable: true,
            },
            ...root,
            ...children,
          ]
          if (root.length + children.length > MAX_COLLECTIONS) {
            throw new Error(
              `Raindrop.io returned more than ${MAX_COLLECTIONS} collections.`
            )
          }
          assertUnique(
            collections.map((collection) => String(collection._id)),
            "collection ID"
          )
          return validateCollectionHierarchy(collections)
        },

        fetchBookmarksPage,

        async fetchBookmarksBatch(scope, page) {
          return fetchPageBatch(page, (nextPage) =>
            fetchBookmarksPage(scope, nextPage)
          )
        },

        fetchHighlightsPage,

        async fetchHighlightsBatch(page) {
          return fetchPageBatch(page, fetchHighlightsPage)
        },
      }
    },
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) return
  await response.body.cancel().catch(() => undefined)
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get("Content-Length")?.trim()
  if (
    contentLength &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_RESPONSE_BYTES
  ) {
    await cancelResponseBody(response)
    throw new Error("Raindrop.io response exceeded the allowed size.")
  }

  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let bytesRead = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytesRead += value.byteLength
      if (bytesRead > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error("Raindrop.io response exceeded the allowed size.")
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
  } finally {
    reader.releaseLock()
  }

  chunks.push(decoder.decode())
  return chunks.join("")
}

function requireAccessToken(): string {
  const token = process.env.RAINDROP_ACCESS_TOKEN?.trim()
  if (!token) {
    throw new Error("RAINDROP_ACCESS_TOKEN is not set.")
  }
  return token
}

function requireExpectedAccountId(): number {
  const value = process.env.RAINDROP_ACCOUNT_ID?.trim()
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(
      "RAINDROP_ACCOUNT_ID must be a positive integer account ID."
    )
  }
  const accountId = Number(value)
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new Error(
      "RAINDROP_ACCOUNT_ID must be a positive integer account ID."
    )
  }
  return accountId
}

function retryAfterSeconds(headers: Headers): number {
  const retryAfter = headers.get("Retry-After")
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)

    const retryAt = Date.parse(retryAfter)
    if (Number.isFinite(retryAt)) {
      return Math.max(1, Math.ceil((retryAt - Date.now()) / 1_000))
    }
  }

  const resetAt = Number(headers.get("X-RateLimit-Reset"))
  if (Number.isFinite(resetAt) && resetAt > 0) {
    return Math.max(1, Math.ceil(resetAt - Date.now() / 1_000))
  }
  return 60
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function responseObject(
  value: unknown,
  label: string
): Record<string, unknown> {
  const object = objectValue(value, label)
  if (object.result !== true) {
    throw new Error(`Raindrop.io ${label} response reported a failure.`)
  }
  return object
}

function responseItems(
  value: Record<string, unknown>,
  label: string
): unknown[] {
  if (!Array.isArray(value.items)) {
    throw new Error(`Raindrop.io ${label} response is missing items.`)
  }
  return value.items
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Raindrop.io ${label} must be an object.`)
  }
  return value
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Raindrop.io ${label} must be a string.`)
  }
  return value
}

function optionalString(value: unknown, label: string): string {
  if (value === undefined || value === null) return ""
  return stringValue(value, label)
}

function integerValue(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Raindrop.io ${label} must be an integer.`)
  }
  return Number(value)
}

function nonNegativeInteger(value: unknown, label: string): number {
  const integer = integerValue(value, label)
  if (integer < 0) {
    throw new Error(`Raindrop.io ${label} must not be negative.`)
  }
  return integer
}

function positiveInteger(value: unknown, label: string): number {
  const integer = integerValue(value, label)
  if (integer <= 0) {
    throw new Error(`Raindrop.io ${label} must be positive.`)
  }
  return integer
}

function collectionIdValue(value: unknown, label: string): number {
  const integer = integerValue(value, label)
  if (integer !== -99 && integer !== -1 && integer <= 0) {
    throw new Error(`Raindrop.io ${label} must be -99, -1, or positive.`)
  }
  return integer
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Raindrop.io ${label} must be a boolean.`)
  }
  return value
}

function optionalBoolean(value: unknown, label: string): boolean {
  if (value === undefined || value === null) return false
  return booleanValue(value, label)
}

function optionalReminderDate(
  value: unknown,
  label: string
): string | undefined {
  if (value === undefined || value === null) return undefined
  const reminder = objectValue(value, label)
  return dateTimeValue(reminder.data, `${label}.data`)
}

function optionalContributor(
  value: unknown,
  label: string
): RaindropBookmark["contributor"] {
  if (value === undefined) return undefined
  const author = objectValue(value, label)
  return {
    id: positiveInteger(author._id, `${label}._id`),
    fullName: stringValue(author.fullName, `${label}.fullName`),
  }
}

function accessLevel(value: unknown, label: string): RaindropAccessLevel {
  const level = integerValue(value, label)
  if (level !== 1 && level !== 2 && level !== 3 && level !== 4) {
    throw new Error(`Raindrop.io ${label} must be 1, 2, 3, or 4.`)
  }
  return level
}

function dateTimeValue(value: unknown, label: string): string {
  const dateTime = stringValue(value, label)
  if (!dateTime || !Number.isFinite(Date.parse(dateTime))) {
    throw new Error(`Raindrop.io ${label} must be an ISO 8601 timestamp.`)
  }
  return new Date(dateTime).toISOString()
}

type NotionUrlValue = {
  value: string | undefined
  omitted: boolean
}

function notionUrlValue(value: unknown, label: string): NotionUrlValue {
  const url = stringValue(value, label)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Raindrop.io ${label} must be an absolute URL.`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Raindrop.io ${label} must use HTTP or HTTPS.`)
  }
  const omitted = url.length > NOTION_URL_LIMIT
  return {
    value: omitted ? undefined : url,
    omitted,
  }
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Raindrop.io ${label} must be an array.`)
  }
  const strings = value.map((item, index) =>
    stringValue(item, `${label}[${index}]`).trim()
  )
  return [...new Set(strings.filter(Boolean))]
}

function bookmarkType(value: unknown, label: string): RaindropType {
  switch (value) {
    case "link":
    case "article":
    case "image":
    case "video":
    case "document":
    case "audio":
      return value
    default:
      throw new Error(`Raindrop.io ${label} has an unsupported bookmark type.`)
  }
}

function highlightColor(value: unknown, label: string): RaindropHighlightColor {
  if (value === undefined || value === null || value === "") return "yellow"
  if (typeof value !== "string") {
    throw new Error(`Raindrop.io ${label} has an unsupported highlight color.`)
  }
  switch (value) {
    case "blue":
    case "brown":
    case "cyan":
    case "gray":
    case "green":
    case "indigo":
    case "orange":
    case "pink":
    case "purple":
    case "red":
    case "teal":
    case "yellow":
      return value
    default:
      throw new Error(
        `Raindrop.io ${label} has an unsupported highlight color.`
      )
  }
}

function parseBookmark(value: unknown, label: string): RaindropBookmark {
  const item = objectValue(value, label)
  const collection = objectValue(item.collection, `${label}.collection`)
  const link = notionUrlValue(item.link, `${label}.link`)
  const highlights = item.highlights
  if (!Array.isArray(highlights)) {
    throw new Error(`Raindrop.io ${label}.highlights must be an array.`)
  }

  return {
    _id: positiveInteger(item._id, `${label}._id`),
    title: stringValue(item.title, `${label}.title`),
    link: link.value,
    linkOmitted: link.omitted,
    domain: optionalString(item.domain, `${label}.domain`),
    excerpt: optionalString(item.excerpt, `${label}.excerpt`),
    note: optionalString(item.note, `${label}.note`),
    type: bookmarkType(item.type, `${label}.type`),
    tags: stringArray(item.tags, `${label}.tags`),
    collection: {
      $id: collectionIdValue(collection.$id, `${label}.collection.$id`),
    },
    important: optionalBoolean(item.important, `${label}.important`),
    broken: optionalBoolean(item.broken, `${label}.broken`),
    reminderAt: optionalReminderDate(item.reminder, `${label}.reminder`),
    created: dateTimeValue(item.created, `${label}.created`),
    lastUpdate: dateTimeValue(item.lastUpdate, `${label}.lastUpdate`),
    highlights,
    contributor: optionalContributor(item.creatorRef, `${label}.creatorRef`),
  }
}

function parseHighlight(value: unknown, label: string): RaindropHighlight {
  const item = objectValue(value, label)
  const id = stringValue(item._id, `${label}._id`).trim()
  if (!id) {
    throw new Error(`Raindrop.io ${label}._id must not be empty.`)
  }
  const link = notionUrlValue(item.link, `${label}.link`)
  return {
    _id: id,
    raindropRef: positiveInteger(item.raindropRef, `${label}.raindropRef`),
    text: stringValue(item.text, `${label}.text`),
    note: optionalString(item.note, `${label}.note`),
    color: highlightColor(item.color, `${label}.color`),
    title: optionalString(item.title, `${label}.title`),
    link: link.value,
    linkOmitted: link.omitted,
    tags: stringArray(item.tags, `${label}.tags`),
    created: dateTimeValue(item.created, `${label}.created`),
  }
}

function parseCollection(
  value: unknown,
  label: string,
  scope: CollectionScope
): RaindropCollection {
  const item = objectValue(value, label)
  const owner = objectValue(item.user, `${label}.user`)
  const access = objectValue(item.access, `${label}.access`)
  const parsedAccessLevel = accessLevel(access.level, `${label}.access.level`)
  let shared = false
  if (item.collaborators !== undefined) {
    objectValue(item.collaborators, `${label}.collaborators`)
    shared = true
  }
  shared ||= parsedAccessLevel === 2 || parsedAccessLevel === 3
  const parent = item.parent
  let parentId: number | undefined
  if (scope === "child") {
    if (parent === undefined || parent === null) {
      throw new Error(`Raindrop.io ${label}.parent is required for a child.`)
    }
    parentId = positiveInteger(
      objectValue(parent, `${label}.parent`).$id,
      `${label}.parent.$id`
    )
  } else if (parent !== undefined && parent !== null) {
    throw new Error(`Raindrop.io ${label}.parent must be absent for a root.`)
  }

  return {
    _id: positiveInteger(item._id, `${label}._id`),
    title: stringValue(item.title, `${label}.title`),
    count: nonNegativeInteger(item.count, `${label}.count`),
    public: booleanValue(item.public, `${label}.public`),
    ownerId: positiveInteger(owner.$id, `${label}.user.$id`),
    accessLevel: parsedAccessLevel,
    shared,
    parentId,
    parentAvailable: true,
    created: dateTimeValue(item.created, `${label}.created`),
    lastUpdate: dateTimeValue(item.lastUpdate, `${label}.lastUpdate`),
  }
}

function validateCollectionHierarchy(
  items: RaindropCollection[]
): RaindropCollection[] {
  const byId = new Map(items.map((item) => [item._id, item]))
  const normalized = items.map((item) => ({
    ...item,
    parentAvailable: item.parentId === undefined || byId.has(item.parentId),
  }))
  const normalizedById = new Map(normalized.map((item) => [item._id, item]))
  for (const item of normalized) {
    const ancestors = new Set<number>([item._id])
    let current = item
    while (current.parentId !== undefined) {
      const parent = normalizedById.get(current.parentId)
      if (!parent) break
      if (ancestors.has(parent._id)) {
        throw new Error("Raindrop.io returned a cyclic collection hierarchy.")
      }
      ancestors.add(parent._id)
      current = parent
    }
  }
  return normalized
}

function assertBookmarkScope(
  items: RaindropBookmark[],
  scope: BookmarkScope
): void {
  for (const item of items) {
    const collectionId = item.collection.$id
    if (scope === "trash" && collectionId !== -99) {
      throw new Error(
        "Raindrop.io Trash response returned a bookmark outside Trash."
      )
    }
    if (scope === "active" && collectionId === -99) {
      throw new Error(
        "Raindrop.io active response returned a bookmark from Trash."
      )
    }
  }
}

function assertPage<T>(
  items: T[],
  key: (item: T) => string,
  label: string
): void {
  if (items.length > PAGE_SIZE) {
    throw new Error(`Raindrop.io returned too many ${label}s in one page.`)
  }
  assertUnique(items.map(key), `${label} ID`)
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Raindrop.io returned a duplicate ${label}.`)
  }
}
