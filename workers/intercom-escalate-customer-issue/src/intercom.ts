import { createHash } from "node:crypto"
import type { RuntimeConfig } from "./config.js"
import { intercomAppBaseUrl, intercomBaseUrl } from "./config.js"
import { EscalationError } from "./types.js"

export class IntercomApiError extends EscalationError {
  constructor(
    code: string,
    message: string,
    public readonly httpStatus: number | null,
    options: {
      retryable?: boolean
      retryAfterMs?: number | null
      ambiguous?: boolean
      status?: "conflict" | "partial_failure" | "ambiguous" | "blocked"
    } = {}
  ) {
    super(
      code,
      message,
      options.status ?? (options.ambiguous ? "ambiguous" : "blocked"),
      options.retryable ?? false,
      options.ambiguous ?? false
    )
    this.retryAfterMs = options.retryAfterMs ?? null
    this.name = "IntercomApiError"
  }

  readonly retryAfterMs: number | null
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>

interface IntercomRequestOptions {
  fetchFn?: FetchLike
  timeoutMs: number
  sleep?: (milliseconds: number) => Promise<void>
  maximumBytes?: number
}

const DEFINITE_MUTATION_REJECTIONS = new Set([
  400, 401, 403, 404, 409, 422, 429,
])

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after")
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds))
    return Math.min(300_000, Math.max(0, Math.round(seconds * 1_000)))
  const date = Date.parse(raw)
  if (Number.isNaN(date)) return null
  return Math.min(300_000, Math.max(0, date - Date.now()))
}

async function boundedResponseText(
  response: Response,
  maximumBytes = 262_144,
  signal?: AbortSignal
): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let output = ""
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
      const pending = reader.read()
      const { done, value } = signal
        ? await new Promise<ReadableStreamReadResult<Uint8Array>>(
            (resolve, reject) => {
              const aborted = (): void => {
                void reader.cancel()
                reject(new DOMException("Aborted", "AbortError"))
              }
              signal.addEventListener("abort", aborted, { once: true })
              void pending.then(
                (chunk) => {
                  signal.removeEventListener("abort", aborted)
                  resolve(chunk)
                },
                (error: unknown) => {
                  signal.removeEventListener("abort", aborted)
                  reject(error)
                }
              )
            }
          )
        : await pending
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel()
        throw new IntercomApiError(
          "RESPONSE_TOO_LARGE",
          "Intercom response exceeded the fixed byte limit.",
          response.status
        )
      }
      output += decoder.decode(value, { stream: true })
    }
    output += decoder.decode()
    return output
  } finally {
    reader.releaseLock()
  }
}

export function isDefiniteIntercomMutationRejection(
  error: unknown
): error is IntercomApiError {
  return (
    error instanceof IntercomApiError &&
    error.httpStatus !== null &&
    DEFINITE_MUTATION_REJECTIONS.has(error.httpStatus) &&
    (error.code === "AUTHENTICATION_EXPIRED" ||
      error.code === `HTTP_${error.httpStatus}`)
  )
}

function safeIntercomMessage(status: number): string {
  return `Intercom returned HTTP ${status}; the response body was not exposed.`
}

export async function requestIntercomJson<T>(
  url: string,
  init: RequestInit,
  options: IntercomRequestOptions & {
    mutation: boolean
    expectedStatuses: number[]
  }
): Promise<T> {
  const fetchFn = options.fetchFn ?? fetch
  const sleep =
    options.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const attempts = options.mutation ? 1 : 3
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs)
    let response: Response
    let text: string
    try {
      response = await fetchFn(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      })
      text = await boundedResponseText(
        response,
        options.maximumBytes,
        controller.signal
      )
    } catch (error) {
      clearTimeout(timeout)
      if (error instanceof IntercomApiError && !options.mutation) {
        const oversizedTransientResponse =
          error.code === "RESPONSE_TOO_LARGE" &&
          error.httpStatus !== null &&
          isTransientStatus(error.httpStatus)
        if (oversizedTransientResponse && attempt + 1 < attempts) {
          await sleep(50 * 2 ** attempt)
          continue
        }
        if (oversizedTransientResponse) {
          throw new IntercomApiError(
            "PROVIDER_UNAVAILABLE",
            safeIntercomMessage(error.httpStatus as number),
            error.httpStatus,
            { retryable: true }
          )
        }
        throw error
      }
      if (!options.mutation && attempt + 1 < attempts) {
        await sleep(50 * 2 ** attempt)
        continue
      }
      throw new IntercomApiError(
        options.mutation ? "MUTATION_OUTCOME_UNKNOWN" : "PROVIDER_UNAVAILABLE",
        options.mutation
          ? `Intercom mutation response was not observed; reconcile before any retry.`
          : `Intercom could not be reached within the bounded retry policy.`,
        null,
        { retryable: !options.mutation, ambiguous: options.mutation }
      )
    }
    if (options.expectedStatuses.includes(response.status)) {
      if (!text) {
        clearTimeout(timeout)
        return undefined as T
      }
      try {
        const parsed = JSON.parse(text) as T
        clearTimeout(timeout)
        return parsed
      } catch {
        clearTimeout(timeout)
        throw new IntercomApiError(
          options.mutation
            ? "MUTATION_OUTCOME_UNKNOWN"
            : "INVALID_PROVIDER_RESPONSE",
          options.mutation
            ? `Intercom mutation returned malformed JSON; reconcile before any retry.`
            : `Intercom returned malformed JSON.`,
          response.status,
          options.mutation ? { ambiguous: true } : {}
        )
      }
    }
    clearTimeout(timeout)
    const delay = retryAfterMs(response.headers)
    if (
      !options.mutation &&
      isTransientStatus(response.status) &&
      attempt + 1 < attempts
    ) {
      await sleep(Math.min(delay ?? 50 * 2 ** attempt, 5_000))
      continue
    }
    if (
      options.mutation &&
      !DEFINITE_MUTATION_REJECTIONS.has(response.status)
    ) {
      throw new IntercomApiError(
        "MUTATION_OUTCOME_UNKNOWN",
        safeIntercomMessage(response.status),
        response.status,
        {
          ambiguous: true,
        }
      )
    }
    throw new IntercomApiError(
      response.status === 401
        ? "AUTHENTICATION_EXPIRED"
        : `HTTP_${response.status}`,
      safeIntercomMessage(response.status),
      response.status,
      {
        retryable: isTransientStatus(response.status),
        retryAfterMs: delay,
        status: response.status === 409 ? "conflict" : "blocked",
      }
    )
  }
  throw new IntercomApiError(
    "PROVIDER_UNAVAILABLE",
    `Intercom exhausted its bounded retry policy.`,
    null,
    {
      retryable: true,
    }
  )
}

const MAX_CONVERSATION_BYTES = 8 * 1024 * 1024
const MAX_CONTACTS = 20
const MAX_TAGS = 100
const MAX_PARTS = 500
const MAX_EVIDENCE_PARTS = 8
const MAX_EVIDENCE_TEXT = 1_200
const MAX_NOTE_TEXT = 2_000
const MAX_PROVIDER_BODY_TEXT = 40_000
const CUSTOMER_AUTHOR_TYPES = new Set(["contact", "lead", "user"])
const SUPPORT_AUTHOR_TYPES = new Set(["admin", "bot", "team"])
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,100}$/

export interface IntercomIdentity {
  adminId: string
  workspaceId: string
}

export interface IntercomTeam {
  id: string
  name: string
}

export interface IntercomTag {
  id: string
  name: string
}

export interface IntercomContact {
  id: string
  name: string | null
}

export interface IntercomCompany {
  id: string
  name: string | null
}

export interface CustomerEvidence {
  partId: string
  createdAt: number
  role: "customer" | "support"
  text: string
}

export interface InternalNoteDigest {
  partId: string
  digest: string
}

export type ConversationState = "open" | "closed" | "snoozed"

export interface ConversationSnapshot {
  id: string
  createdAt: number
  updatedAt: number
  state: ConversationState
  priority: boolean
  title: string
  openingMessage: string | null
  contactIds: string[]
  companyId: string | null
  teamAssigneeId: string | null
  slaStatus: string | null
  tags: IntercomTag[]
  customerEvidence: CustomerEvidence[]
  evidenceTruncated: boolean
  partsTruncated: boolean
  internalNoteDigests: InternalNoteDigest[]
}

interface IntercomClientOptions {
  fetchFn?: FetchLike
  sleep?: (milliseconds: number) => Promise<void>
}

function invalidResponse(message: string): EscalationError {
  return new EscalationError(
    "INVALID_PROVIDER_RESPONSE",
    `Intercom returned ${message}.`
  )
}

function ambiguousResponse(message: string): EscalationError {
  return new EscalationError(
    "MUTATION_OUTCOME_UNKNOWN",
    `Intercom may have completed the mutation, but ${message}; reconcile live state before retrying.`,
    "ambiguous",
    false,
    true
  )
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse(`an invalid ${label}`)
  }
  return value as Record<string, unknown>
}

function providerId(value: unknown, label: string): string {
  if (typeof value !== "string" || !PROVIDER_ID.test(value)) {
    throw invalidResponse(`an invalid ${label}`)
  }
  return value
}

function inputProviderId(value: string, label: string): string {
  if (typeof value !== "string" || !PROVIDER_ID.test(value)) {
    throw new EscalationError(
      "INVALID_INPUT",
      `${label} must be a 1–100 character Intercom identifier.`
    )
  }
  return value
}

function canonicalConversationId(value: string): string {
  const candidate = value.startsWith("conversation_")
    ? value.slice("conversation_".length)
    : value
  if (candidate.startsWith("conversation_")) {
    throw new EscalationError(
      "INVALID_INPUT",
      "Conversation reference contains more than one conversation_ prefix."
    )
  }
  return inputProviderId(candidate, "Conversation ID")
}

export function normalizeIntercomConversationReference(
  value: string,
  expected?: {
    region: RuntimeConfig["intercomRegion"]
    workspaceId: string
  }
): string {
  if (typeof value !== "string") {
    throw new EscalationError(
      "INVALID_INPUT",
      "Conversation reference must be an Intercom conversation ID or Inbox URL."
    )
  }
  const reference = value.trim()
  if (!reference) {
    throw new EscalationError(
      "INVALID_INPUT",
      "Conversation reference must be an Intercom conversation ID or Inbox URL."
    )
  }

  if (reference.includes("://")) {
    let url: URL
    try {
      url = new URL(reference)
    } catch {
      throw new EscalationError(
        "INVALID_INPUT",
        "Conversation reference must be a canonical Intercom Inbox URL."
      )
    }
    const allowedHosts = new Set([
      "app.intercom.com",
      "app.eu.intercom.com",
      "app.au.intercom.com",
    ])
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !allowedHosts.has(url.hostname)
    ) {
      throw new EscalationError(
        "INVALID_INPUT",
        "Conversation reference must be a canonical Intercom Inbox URL."
      )
    }
    const parts = url.pathname.split("/").filter(Boolean)
    if (
      parts.length !== 8 ||
      parts[0] !== "a" ||
      parts[1] !== "inbox" ||
      parts[3] !== "inbox" ||
      parts[4] !== "shared" ||
      parts[5] !== "all" ||
      parts[6] !== "conversation"
    ) {
      throw new EscalationError(
        "INVALID_INPUT",
        "Conversation reference must be a canonical Intercom Inbox URL."
      )
    }
    let workspaceId: string
    let conversationId: string
    try {
      workspaceId = decodeURIComponent(parts[2])
      conversationId = decodeURIComponent(parts[7])
    } catch {
      throw new EscalationError(
        "INVALID_INPUT",
        "Conversation reference contains an invalid encoded identifier."
      )
    }
    inputProviderId(workspaceId, "Workspace ID")
    const normalized = canonicalConversationId(conversationId)
    if (
      expected &&
      (workspaceId !== expected.workspaceId ||
        url.origin !== intercomAppBaseUrl(expected.region))
    ) {
      throw new EscalationError(
        "INTERCOM_REFERENCE_MISMATCH",
        "The Intercom Inbox URL belongs to a different configured workspace or region.",
        "conflict"
      )
    }
    return normalized
  }

  return canonicalConversationId(reference)
}

function requiredString(
  value: unknown,
  label: string,
  maximum: number
): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw invalidResponse(`an invalid ${label}`)
  }
  return value
}

function optionalString(
  value: unknown,
  label: string,
  maximum: number
): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "string" || value.length > maximum) {
    throw invalidResponse(`an invalid ${label}`)
  }
  return value
}

function boundedOptionalBody(
  value: unknown,
  label: string
): { value: string | null; truncated: boolean } {
  if (value === null || value === undefined) {
    return { value: null, truncated: false }
  }
  if (typeof value !== "string") {
    throw invalidResponse(`an invalid ${label}`)
  }
  return {
    value: value.slice(0, MAX_PROVIDER_BODY_TEXT),
    truncated: value.length > MAX_PROVIDER_BODY_TEXT,
  }
}

function unixSeconds(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidResponse(`an invalid ${label}`)
  }
  return value as number
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidResponse(`an invalid ${label}`)
  }
  return value
}

function nullableAssigneeId(value: unknown, label: string): string | null {
  if (value === null || value === 0 || value === "0") return null
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value)
  }
  return providerId(value, label)
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const number = Number(code)
      return Number.isInteger(number) && number >= 32 && number <= 0x10ffff
        ? String.fromCodePoint(number)
        : " "
    })
}

function plainText(value: string): string {
  return decodeEntities(
    value.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, " ")
  )
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
}

function safeLink(raw: string): string {
  const punctuation = raw.match(/[.,;:!?]+$/)?.[0] ?? ""
  const candidate = punctuation ? raw.slice(0, -punctuation.length) : raw
  const hasProtocol = /^https?:\/\//i.test(candidate)
  try {
    const url = new URL(
      hasProtocol ? candidate : `https://${candidate.replace(/^www\./i, "")}`
    )
    if (
      !(url.protocol === "https:" || url.protocol === "http:") ||
      url.username ||
      url.password
    ) {
      return `[link omitted]${punctuation}`
    }
    url.search = ""
    url.hash = ""
    const safe = hasProtocol ? url.toString() : `${url.hostname}${url.pathname}`
    return `${safe.slice(0, 500)}${punctuation}`
  } catch {
    return `[link omitted]${punctuation}`
  }
}

function publicText(value: string, maximum: number): string {
  return plainText(value)
    .replace(/\bmailto:[^\s<>()]+/gi, "[email omitted]")
    .replace(/[^\s<>()@]+@[^\s<>()@]+/g, "[email omitted]")
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>()]+/gi, safeLink)
    .replace(
      /(?<![\/@])\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>()]*)?/gi,
      safeLink
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum)
}

function normalizedNoteBody(value: string): string {
  return plainText(value).slice(0, MAX_NOTE_TEXT)
}

export function intercomNoteDigest(body: string): string {
  if (
    body.length < 1 ||
    body.length > MAX_NOTE_TEXT ||
    /[\u0000\u000b\u000c\u000e-\u001f\u007f]/.test(body)
  ) {
    throw new EscalationError(
      "INVALID_INPUT",
      `The Intercom internal note must contain 1–${MAX_NOTE_TEXT} characters of bounded text.`
    )
  }
  const normalized = normalizedNoteBody(body)
  if (!normalized) {
    throw new EscalationError(
      "INVALID_INPUT",
      "The Intercom internal note cannot be empty."
    )
  }
  return createHash("sha256").update(normalized).digest("hex")
}

function parseTags(value: unknown): IntercomTag[] {
  const wrapper = record(value, "tags collection")
  if (wrapper.type !== "tag.list") {
    throw invalidResponse("an invalid tags collection type")
  }
  if (!Array.isArray(wrapper.tags) || wrapper.tags.length > MAX_TAGS) {
    throw invalidResponse(
      `tags collection; at most ${MAX_TAGS} tags are supported`
    )
  }
  const seen = new Set<string>()
  return wrapper.tags.map((value, index) => {
    const tag = record(value, `tag ${index + 1}`)
    const id = providerId(tag.id, "tag ID")
    if (seen.has(id)) throw invalidResponse("duplicate tag IDs")
    seen.add(id)
    const name = publicText(requiredString(tag.name, "tag name", 500), 200)
    if (!name) throw invalidResponse("an empty tag name")
    return { id, name }
  })
}

function parseContactIds(value: unknown): string[] {
  const wrapper = record(value, "contacts collection")
  if (wrapper.type !== "contact.list") {
    throw invalidResponse("an invalid contacts collection type")
  }
  if (
    !Array.isArray(wrapper.contacts) ||
    wrapper.contacts.length > MAX_CONTACTS
  ) {
    throw invalidResponse(
      `contacts collection; at most ${MAX_CONTACTS} contacts are supported`
    )
  }
  const ids = wrapper.contacts.map((value, index) =>
    providerId(record(value, `contact ${index + 1}`).id, "contact ID")
  )
  if (new Set(ids).size !== ids.length) {
    throw invalidResponse("duplicate contact IDs")
  }
  return ids
}

function parseCompanyId(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return providerId(record(value, "company").id, "company ID")
}

function parseSlaStatus(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const sla = record(value, "SLA")
  const status = optionalString(sla.sla_status, "SLA status", 100)
  if (status === null) return null
  const normalized = publicText(status, 100)
  return normalized || null
}

function parseOpeningMessage(value: unknown): {
  text: string | null
  truncated: boolean
} {
  const source = record(value, "source")
  requiredString(source.type, "source type", 100)
  const redacted = requiredBoolean(source.redacted, "source redacted flag")
  const body = boundedOptionalBody(source.body, "source body")
  if (redacted || !body.value) {
    return { text: null, truncated: redacted || body.truncated }
  }
  if (!source.author || typeof source.author !== "object") {
    return { text: null, truncated: true }
  }
  const author = source.author as Record<string, unknown>
  if (typeof author.type !== "string") return { text: null, truncated: true }
  const authorType = author.type.toLowerCase().trim()
  if (!CUSTOMER_AUTHOR_TYPES.has(authorType)) {
    return { text: null, truncated: false }
  }
  const text = publicText(body.value, MAX_EVIDENCE_TEXT + 1)
  return {
    text: text.slice(0, MAX_EVIDENCE_TEXT) || null,
    truncated: body.truncated || text.length > MAX_EVIDENCE_TEXT,
  }
}

function parseConversationParts(value: unknown): {
  evidence: CustomerEvidence[]
  evidenceTruncated: boolean
  total: number
  partsTruncated: boolean
  noteDigests: InternalNoteDigest[]
} {
  const wrapper = record(value, "conversation_parts collection")
  if (wrapper.type !== "conversation_part.list") {
    throw invalidResponse("an invalid conversation_parts collection type")
  }
  const values = wrapper.conversation_parts
  if (!Array.isArray(values) || values.length > MAX_PARTS) {
    throw invalidResponse(
      `conversation_parts collection; at most ${MAX_PARTS} returned parts are supported`
    )
  }
  const total = unixSeconds(wrapper.total_count, "conversation part count")
  if (total < values.length) {
    throw invalidResponse("conversation part count")
  }

  const evidence: CustomerEvidence[] = []
  const noteDigests: InternalNoteDigest[] = []
  const partIds = new Set<string>()
  let evidenceIncomplete = false

  values.forEach((value, index) => {
    const part = record(value, `conversation part ${index + 1}`)
    const partId = providerId(part.id, "conversation part ID")
    if (partIds.has(partId)) {
      throw invalidResponse("duplicate conversation part IDs")
    }
    partIds.add(partId)

    const type = requiredString(part.part_type, "conversation part type", 100)
      .toLowerCase()
      .trim()
    const createdAt = unixSeconds(
      part.created_at,
      "conversation part created_at"
    )
    const redacted = requiredBoolean(
      part.redacted,
      "conversation part redacted flag"
    )
    const body = boundedOptionalBody(part.body, "conversation part body")

    if (type === "note" && !redacted && body.value && !body.truncated) {
      noteDigests.push({
        partId,
        digest: createHash("sha256")
          .update(normalizedNoteBody(body.value))
          .digest("hex"),
      })
      return
    }

    if (type !== "comment") return
    if (redacted) {
      evidenceIncomplete = true
      return
    }
    if (!part.author || typeof part.author !== "object") {
      evidenceIncomplete = true
      return
    }
    const author = part.author as Record<string, unknown>
    if (typeof author.type !== "string") {
      evidenceIncomplete = true
      return
    }
    const authorType = author.type.toLowerCase().trim()
    const role = CUSTOMER_AUTHOR_TYPES.has(authorType)
      ? "customer"
      : SUPPORT_AUTHOR_TYPES.has(authorType)
        ? "support"
        : null
    if (role === null || !body.value) {
      evidenceIncomplete = true
      return
    }
    const bounded = publicText(body.value, MAX_EVIDENCE_TEXT + 1)
    if (body.truncated || bounded.length > MAX_EVIDENCE_TEXT) {
      evidenceIncomplete = true
    }
    const text = bounded.slice(0, MAX_EVIDENCE_TEXT)
    if (text) evidence.push({ partId, createdAt, role, text })
  })

  evidence.sort(
    (left, right) =>
      right.createdAt - left.createdAt ||
      left.partId.localeCompare(right.partId)
  )
  noteDigests.sort((left, right) => left.partId.localeCompare(right.partId))

  const partsTruncated = total > values.length
  return {
    evidence: evidence.slice(0, MAX_EVIDENCE_PARTS),
    evidenceTruncated:
      partsTruncated ||
      evidenceIncomplete ||
      evidence.length > MAX_EVIDENCE_PARTS,
    total,
    partsTruncated,
    noteDigests,
  }
}

function mutationRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  try {
    return record(value, label)
  } catch {
    throw ambiguousResponse(`the ${label} response was malformed`)
  }
}

export class IntercomClient {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>

  constructor(
    private readonly config: RuntimeConfig,
    private readonly options: IntercomClientOptions = {}
  ) {
    this.baseUrl = intercomBaseUrl(config.intercomRegion)
    this.headers = {
      Accept: "application/json",
      Authorization: `Bearer ${config.intercomToken}`,
      "Content-Type": "application/json",
      "Intercom-Version": "2.15",
    }
  }

  private request<T>(
    path: string,
    init: RequestInit = {},
    mutation = false,
    expectedStatuses = [200],
    maximumBytes = 262_144
  ): Promise<T> {
    return requestIntercomJson<T>(
      `${this.baseUrl}${path}`,
      { ...init, headers: { ...this.headers, ...(init.headers ?? {}) } },
      {
        fetchFn: this.options.fetchFn,
        sleep: this.options.sleep,
        timeoutMs: this.config.requestTimeoutMs,
        maximumBytes,
        mutation,
        expectedStatuses,
      }
    )
  }

  async getIdentity(): Promise<IntercomIdentity> {
    const raw = record(await this.request<unknown>("/me"), "identity")
    if (raw.type !== "admin") throw invalidResponse("an invalid identity type")
    const app = record(raw.app, "workspace identity")
    return {
      adminId: providerId(raw.id, "admin ID"),
      workspaceId: providerId(app.id_code, "workspace ID"),
    }
  }

  async getTeam(teamId: string): Promise<IntercomTeam> {
    const expectedId = inputProviderId(teamId, "Team ID")
    const raw = record(
      await this.request<unknown>(`/teams/${encodeURIComponent(expectedId)}`),
      "team"
    )
    if (raw.type !== "team") throw invalidResponse("an invalid team type")
    const id = providerId(raw.id, "team ID")
    if (id !== expectedId) throw invalidResponse("a different team ID")
    const name = publicText(requiredString(raw.name, "team name", 500), 200)
    if (!name) throw invalidResponse("an empty team name")
    return { id, name }
  }

  async getTag(tagId: string): Promise<IntercomTag> {
    const expectedId = inputProviderId(tagId, "Tag ID")
    const raw = record(
      await this.request<unknown>(`/tags/${encodeURIComponent(expectedId)}`),
      "tag"
    )
    if (raw.type !== "tag") throw invalidResponse("an invalid tag type")
    const id = providerId(raw.id, "tag ID")
    if (id !== expectedId) throw invalidResponse("a different tag ID")
    const name = publicText(requiredString(raw.name, "tag name", 500), 200)
    if (!name) throw invalidResponse("an empty tag name")
    return { id, name }
  }

  async getContact(contactId: string): Promise<IntercomContact> {
    const expectedId = inputProviderId(contactId, "Contact ID")
    const raw = record(
      await this.request<unknown>(
        `/contacts/${encodeURIComponent(expectedId)}`
      ),
      "contact"
    )
    if (raw.type !== "contact") {
      throw invalidResponse("an invalid contact type")
    }
    const id = providerId(raw.id, "contact ID")
    if (id !== expectedId) throw invalidResponse("a different contact ID")
    const displayName = optionalString(raw.name, "contact name", 500)
    const name = displayName ? publicText(displayName, 200) : ""
    return { id, name: name || null }
  }

  async getCompany(companyId: string): Promise<IntercomCompany> {
    const expectedId = inputProviderId(companyId, "Company ID")
    const raw = record(
      await this.request<unknown>(
        `/companies/${encodeURIComponent(expectedId)}`
      ),
      "company"
    )
    if (raw.type !== "company") {
      throw invalidResponse("an invalid company type")
    }
    const id = providerId(raw.id, "company ID")
    if (id !== expectedId) throw invalidResponse("a different company ID")
    const displayName = optionalString(raw.name, "company name", 500)
    const name = displayName ? publicText(displayName, 200) : ""
    return { id, name: name || null }
  }

  async getConversation(conversationId: string): Promise<ConversationSnapshot> {
    const expectedId = normalizeIntercomConversationReference(conversationId, {
      region: this.config.intercomRegion,
      workspaceId: this.config.intercomWorkspaceId,
    })
    const raw = record(
      await this.request<unknown>(
        `/conversations/${encodeURIComponent(expectedId)}?display_as=plaintext`,
        {},
        false,
        [200],
        MAX_CONVERSATION_BYTES
      ),
      "conversation"
    )
    if (raw.type !== "conversation") {
      throw invalidResponse("an invalid conversation type")
    }
    const id = providerId(raw.id, "conversation ID")
    if (id !== expectedId) {
      throw invalidResponse("a different conversation ID")
    }
    const state = requiredString(raw.state, "conversation state", 100)
    if (!(state === "open" || state === "closed" || state === "snoozed")) {
      throw invalidResponse("an unsupported conversation state")
    }
    const priority =
      optionalString(raw.priority, "conversation priority", 100) ??
      "not_priority"
    if (!(priority === "priority" || priority === "not_priority")) {
      throw invalidResponse("an unsupported conversation priority")
    }
    const titleText = optionalString(raw.title, "conversation title", 10_000)
    const title = titleText ? publicText(titleText, 200) : ""
    const parts = parseConversationParts(raw.conversation_parts)
    const opening = parseOpeningMessage(raw.source)

    return {
      id,
      createdAt: unixSeconds(raw.created_at, "conversation created_at"),
      updatedAt: unixSeconds(raw.updated_at, "conversation updated_at"),
      state,
      priority: priority === "priority",
      title: title || `Conversation ${id}`,
      openingMessage: opening.text,
      contactIds: parseContactIds(raw.contacts),
      companyId: parseCompanyId(raw.company),
      teamAssigneeId: nullableAssigneeId(
        raw.team_assignee_id,
        "team assignee ID"
      ),
      slaStatus: parseSlaStatus(raw.sla_applied),
      tags: parseTags(raw.tags),
      customerEvidence: parts.evidence,
      evidenceTruncated: parts.evidenceTruncated || opening.truncated,
      partsTruncated: parts.partsTruncated,
      internalNoteDigests: parts.noteDigests,
    }
  }

  async addTag(conversationId: string, tagId: string): Promise<void> {
    const sourceId = normalizeIntercomConversationReference(conversationId, {
      region: this.config.intercomRegion,
      workspaceId: this.config.intercomWorkspaceId,
    })
    const expectedTagId = inputProviderId(tagId, "Tag ID")
    const response = await this.request<unknown>(
      `/conversations/${encodeURIComponent(sourceId)}/tags`,
      {
        method: "POST",
        body: JSON.stringify({
          id: expectedTagId,
          admin_id: this.config.intercomAdminId,
        }),
      },
      true
    )
    const raw = mutationRecord(response, "tag mutation")
    if (raw.type !== "tag" || raw.id !== expectedTagId) {
      throw ambiguousResponse("the tag response did not confirm the target tag")
    }
  }

  async routeToTeam(conversationId: string, teamId: string): Promise<void> {
    const sourceId = normalizeIntercomConversationReference(conversationId, {
      region: this.config.intercomRegion,
      workspaceId: this.config.intercomWorkspaceId,
    })
    const expectedTeamId = inputProviderId(teamId, "Team ID")
    const response = await this.request<unknown>(
      `/conversations/${encodeURIComponent(sourceId)}/parts`,
      {
        method: "POST",
        body: JSON.stringify({
          message_type: "assignment",
          type: "team",
          admin_id: this.config.intercomAdminId,
          assignee_id: expectedTeamId,
        }),
      },
      true,
      [200],
      MAX_CONVERSATION_BYTES
    )
    const raw = mutationRecord(response, "assignment mutation")
    let returnedTeamId: string | null
    try {
      returnedTeamId = nullableAssigneeId(
        raw.team_assignee_id,
        "team assignee ID"
      )
    } catch {
      throw ambiguousResponse("the assignment response was malformed")
    }
    if (
      raw.type !== "conversation" ||
      raw.id !== sourceId ||
      returnedTeamId !== expectedTeamId
    ) {
      throw ambiguousResponse(
        "the assignment response did not confirm the target team"
      )
    }
  }

  async addInternalNote(conversationId: string, body: string): Promise<void> {
    const sourceId = normalizeIntercomConversationReference(conversationId, {
      region: this.config.intercomRegion,
      workspaceId: this.config.intercomWorkspaceId,
    })
    intercomNoteDigest(body)
    const response = await this.request<unknown>(
      `/conversations/${encodeURIComponent(sourceId)}/reply`,
      {
        method: "POST",
        body: JSON.stringify({
          message_type: "note",
          type: "admin",
          admin_id: this.config.intercomAdminId,
          body,
        }),
      },
      true,
      [200],
      MAX_CONVERSATION_BYTES
    )
    const raw = mutationRecord(response, "internal note mutation")
    if (raw.type !== "conversation" || raw.id !== sourceId) {
      throw ambiguousResponse(
        "the internal note response did not confirm the target conversation"
      )
    }
  }
}
