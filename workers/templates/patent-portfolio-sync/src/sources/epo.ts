// ──────────────────────────────────────────────────────────────────────
// EPO Open Patent Services (OPS) — European Patent Register adapter (live)
// ──────────────────────────────────────────────────────────────────────
//
// Discovers EP applications by applicant via Register search, then retrieves
// the authoritative bibliographic records in bounded batches. Search results
// are deliberately used only for identifiers because OPS documents that they
// contain a shortened subset of Register data. OAuth2 client-credentials
// tokens are cached and refreshed once on an OPS 401.

import { fetchWithTimeout } from "../engine/http.js"
import type { PatentRecord } from "./types.js"

const AUTH_URL = "https://ops.epo.org/3.2/auth/accesstoken"
// Exported so the optional document-retrieval tools (src/tools/documents.ts)
// reuse OPS auth + the XML-as-JSON helpers instead of duplicating them.
export const OPS_REST = "https://ops.epo.org/3.2/rest-services"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OpsNode = any
export const opsArr = <T>(x: T | T[] | null | undefined): T[] =>
  x == null ? [] : Array.isArray(x) ? x : [x]
export const opsText = (x: OpsNode): string | null => {
  if (typeof x === "string" || typeof x === "number") return String(x)
  const value = x?.["$"]
  return value == null ? null : String(value)
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  const days = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ]
  return (
    year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
  )
}

function opsDate(value: string | null): string | null {
  if (!value) return null
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value)
  if (!match) return null
  const [, yearText, monthText, dayText] = match
  if (!isValidDateParts(Number(yearText), Number(monthText), Number(dayText)))
    return null
  return `${yearText}-${monthText}-${dayText}`
}

function strictOpsDate(value: string | null, context: string): string | null {
  if (value == null || value.trim() === "") return null
  const date = opsDate(value.trim())
  if (!date)
    throw new Error(`${context}: invalid EPO date ${JSON.stringify(value)}`)
  return date
}

async function responseExcerpt(response: Response): Promise<string> {
  return (await response.text().catch(() => ""))
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 200)
}

async function responseJson(
  response: Response,
  context: string
): Promise<OpsNode> {
  const text = await response.text().catch(() => "")
  try {
    const value: unknown = JSON.parse(text)
    if (!isObject(value)) throw new Error("top-level value is not an object")
    return value
  } catch (error) {
    const detail = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 200)
    throw new Error(
      `${context}: malformed JSON (${detail}); response=${text
        .replace(/[\r\n\t]+/g, " ")
        .slice(0, 200)}`
    )
  }
}

let tokenCache: { token: string; expiresAtMs: number } | null = null
let tokenRequest: Promise<string> | null = null

const MAX_REQUESTS_PER_ACQUISITION = 120
const REQUEST_TIMEOUT_RESERVE_MS = 31_000

type OpsSession = {
  pace: () => Promise<void>
  deadlineMs: number
  requestCount: number
}

function tokenIsFresh(): boolean {
  return Boolean(tokenCache && Date.now() < tokenCache.expiresAtMs - 60_000)
}

// OAuth client-credentials; ~20-min token, cached. Exported for reuse by the
// document-retrieval tools.
export function invalidateEpoToken(rejectedToken?: string): void {
  // A late 401 from one concurrent request must not discard a token another
  // request has already refreshed.
  if (!rejectedToken || tokenCache?.token === rejectedToken) tokenCache = null
}

export async function epoToken(
  beforeRequest?: () => Promise<void>
): Promise<string> {
  if (tokenIsFresh()) return tokenCache!.token
  if (tokenRequest) return tokenRequest
  tokenRequest = requestEpoToken(beforeRequest)
  try {
    return await tokenRequest
  } finally {
    tokenRequest = null
  }
}

async function requestEpoToken(
  beforeRequest?: () => Promise<void>
): Promise<string> {
  const id = process.env.EPO_CONSUMER_KEY
  const secret = process.env.EPO_CONSUMER_SECRET
  if (!id || !secret)
    throw new Error(
      "EPO_CONSUMER_KEY / EPO_CONSUMER_SECRET env vars are not set"
    )
  await beforeRequest?.()
  const response = await fetchWithTimeout(AUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  })
  if (!response.ok)
    throw new Error(
      `EPO OPS auth ${response.status}: ${await responseExcerpt(response)}`
    )
  const json = (await responseJson(response, "EPO OPS auth")) as {
    access_token?: unknown
    expires_in?: unknown
  }
  if (typeof json.access_token !== "string" || !json.access_token)
    throw new Error("EPO OPS auth: no access_token")
  const parsedExpiresIn = Number(json.expires_in ?? 1200)
  const expiresIn =
    Number.isFinite(parsedExpiresIn) && parsedExpiresIn > 0
      ? parsedExpiresIn
      : 1200
  tokenCache = {
    token: json.access_token,
    expiresAtMs: Date.now() + expiresIn * 1000,
  }
  return tokenCache.token
}

function ensureRequestTime(session: OpsSession, context: string): void {
  if (Date.now() + REQUEST_TIMEOUT_RESERVE_MS >= session.deadlineMs)
    throw new Error(
      `${context}: not enough shared execution time remains for another request; narrow the applicant aliases`
    )
}

async function beforeSessionRequest(
  session: OpsSession,
  context: string
): Promise<void> {
  if (session.requestCount >= MAX_REQUESTS_PER_ACQUISITION)
    throw new Error(
      `EPO OPS acquisition exceeded the shared ${MAX_REQUESTS_PER_ACQUISITION}-request budget; narrow the applicant aliases`
    )
  ensureRequestTime(session, context)
  await session.pace()
  ensureRequestTime(session, `${context} after pacing`)
  session.requestCount++
}

async function sessionToken(session: OpsSession): Promise<string> {
  const token = await epoToken(() =>
    beforeSessionRequest(session, "EPO OPS authentication")
  )
  // A concurrent caller may have started the shared token request. Check the
  // deadline again even when this session did not initiate that network call.
  ensureRequestTime(session, "EPO OPS authentication")
  return token
}

type OpsRequestOptions = {
  method?: "GET" | "POST"
  headers?: Record<string, string>
  body?: string
}

async function opsRequest(
  path: string,
  session: OpsSession,
  options: OpsRequestOptions = {}
): Promise<OpsNode> {
  const request = async (token: string): Promise<Response> => {
    await beforeSessionRequest(session, `EPO OPS ${path}`)
    return fetchWithTimeout(`${OPS_REST}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...options.headers,
      },
      body: options.body,
    })
  }

  let token = await sessionToken(session)
  let response = await request(token)
  if (response.status === 401) {
    // The service can expire or revoke a token before its advertised TTL.
    // Invalidate it and retry this request exactly once with fresh auth.
    invalidateEpoToken(token)
    token = await sessionToken(session)
    response = await request(token)
  }
  if (!response.ok)
    throw new Error(
      `EPO OPS ${path} ${response.status}: ${await responseExcerpt(response)}`
    )
  return responseJson(response, `EPO OPS ${path}`)
}

async function opsGet(
  path: string,
  session: OpsSession,
  headers?: Record<string, string>
): Promise<OpsNode> {
  return opsRequest(path, session, { headers })
}

async function opsPost(
  path: string,
  session: OpsSession,
  body: string,
  headers?: Record<string, string>
): Promise<OpsNode> {
  return opsRequest(path, session, { method: "POST", body, headers })
}

function normalizeApplicantName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function normalizedApplicants(applicants: string[]): string[] {
  const byQuery = new Map<string, string>()
  for (const applicant of applicants) {
    const normalized = normalizeApplicantName(applicant)
    if (!normalized) continue
    if (normalized.split(" ").length > 10)
      throw new Error(
        `EPO applicant query exceeds the Register's 10-term limit: ${JSON.stringify(normalized)}`
      )
    const key = normalized.toLocaleLowerCase("en-US")
    if (!byQuery.has(key)) byQuery.set(key, normalized)
  }
  if (byQuery.size === 0)
    throw new Error("EPO discovery requires at least one non-empty applicant")
  return [...byQuery.values()]
}

function registerSearch(raw: OpsNode, context: string): OpsNode {
  const world = raw?.["ops:world-patent-data"]
  const search = world?.["ops:register-search"]
  if (!isObject(world) || !isObject(search))
    throw new Error(`${context}: malformed Register search envelope`)
  return search
}

function totalResultCount(search: OpsNode, context: string): number {
  const value = search?.["@total-result-count"]
  const total =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN
  if (!Number.isSafeInteger(total) || total < 0)
    throw new Error(`${context}: invalid or missing total-result-count`)
  return total
}

function registerDocuments(search: OpsNode, context: string): OpsNode[] {
  const container = search?.["reg:register-documents"]
  if (container == null) return []
  if (!isObject(container))
    throw new Error(`${context}: malformed register-documents envelope`)
  const rawDocuments = container["reg:register-document"]
  if (rawDocuments == null) return []
  const documents = opsArr(rawDocuments)
  if (!documents.every(isObject))
    throw new Error(`${context}: malformed register-document entry`)
  return documents
}

function documentIds(
  reference: OpsNode,
  context = "EPO Register reference"
): OpsNode[] {
  if (reference == null) return []
  const output: OpsNode[] = []
  for (const entry of opsArr(reference)) {
    if (!isObject(entry)) throw new Error(`${context}: malformed reference`)
    const rawIds = entry["reg:document-id"]
    if (rawIds == null) continue
    const ids = opsArr(rawIds)
    if (!ids.every(isObject))
      throw new Error(`${context}: malformed document-id`)
    output.push(...ids)
  }
  return output
}

function strictElementText(value: OpsNode, context: string): string | null {
  if (value == null) return null
  if (typeof value === "string" || typeof value === "number")
    return String(value)
  if (!isObject(value)) throw new Error(`${context}: malformed value`)
  if (Object.keys(value).length === 0) return null
  if (!("$" in value)) throw new Error(`${context}: malformed value`)
  const text = value["$"]
  if (text == null || text === "") return null
  if (typeof text !== "string" && typeof text !== "number")
    throw new Error(`${context}: malformed text value`)
  return String(text)
}

function gazetteRank(valueNode: OpsNode, context: string): number {
  const value = valueNode?.["@change-gazette-num"]
  if (value == null || value === "") return 0
  if (typeof value !== "string" && typeof value !== "number")
    throw new Error(`${context}: malformed change-gazette-num`)
  const text = String(value).trim()
  if (text.toUpperCase() === "N/P") return 0
  const match = /^(\d{4})\/(\d{2})$/.exec(text)
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 53)
    throw new Error(
      `${context}: invalid change-gazette-num ${JSON.stringify(value)}`
    )
  return Number(match[1]) * 100 + Number(match[2])
}

function newestByGazette<T>(
  values: T[],
  valueNode: (value: T) => OpsNode,
  semanticValue: (value: T) => string,
  context: string
): T | null {
  let selected: T | null = null
  let selectedRank = -1
  let selectedSemantic = ""
  for (const value of values) {
    const rank = gazetteRank(valueNode(value), context)
    const semantic = semanticValue(value)
    if (selected === null || rank > selectedRank) {
      selected = value
      selectedRank = rank
      selectedSemantic = semantic
    } else if (rank === selectedRank && semantic !== selectedSemantic) {
      throw new Error(
        `${context}: conflicting values share change gazette ${rank === 0 ? "N/P or absent" : String(rank)}`
      )
    }
  }
  // Register corrections are newest-first. Identical duplicates at the same
  // rank are harmless; retaining the first prevents array order from silently
  // changing which conflicting value wins.
  return selected
}

type ApplicationId = { reference: OpsNode; id: OpsNode | null }

function applicationIdSemantic(candidate: ApplicationId): string {
  if (!candidate.id) return JSON.stringify(null)
  const country = (
    strictElementText(
      candidate.id["reg:country"],
      "EPO Register application-reference country"
    ) ?? ""
  )
    .trim()
    .toUpperCase()
  if (country !== "EP")
    throw new Error(
      `EPO Register application-reference: expected EP country, received ${JSON.stringify(country)}`
    )
  const rawDigits = (
    strictElementText(
      candidate.id["reg:doc-number"],
      "EPO Register application-reference doc-number"
    ) ?? ""
  ).trim()
  const digits = rawDigits.replace(/^EP/i, "")
  if (!/^\d{8}$/.test(digits))
    throw new Error(
      `EPO Register application-reference: invalid EP application number ${JSON.stringify(rawDigits)}`
    )
  const date = strictOpsDate(
    strictElementText(
      candidate.id["reg:date"],
      "EPO Register application-reference date"
    ),
    "EPO Register application-reference"
  )
  return JSON.stringify([digits, date])
}

function currentEpApplicationId(bib: OpsNode): ApplicationId | null {
  const candidates: ApplicationId[] = []
  for (const reference of opsArr(bib?.["reg:application-reference"])) {
    if (!isObject(reference))
      throw new Error("EPO Register result: malformed application-reference")
    const ids = documentIds(reference, "EPO Register application-reference")
    if (ids.length !== 1)
      throw new Error(
        `EPO Register application-reference: expected exactly one document-id, received ${ids.length}`
      )
    const [id] = ids
    const country = (
      strictElementText(
        id["reg:country"],
        "EPO Register application-reference country"
      ) ?? ""
    )
      .trim()
      .toUpperCase()
    const docNumber = (
      strictElementText(
        id["reg:doc-number"],
        "EPO Register application-reference doc-number"
      ) ?? ""
    ).trim()
    const date = (
      strictElementText(
        id["reg:date"],
        "EPO Register application-reference date"
      ) ?? ""
    ).trim()
    // An empty correction is a deletion. Keep it in the EP correction stream
    // so a newer empty value cannot revive an older application date/value.
    if (!country && !docNumber && !date) {
      candidates.push({ reference, id: null })
    } else if (country === "EP") {
      candidates.push({ reference, id })
    } else if (country === "WO") {
      if (!docNumber)
        throw new Error(
          "EPO Register application-reference: WO document-id has no application number"
        )
      strictOpsDate(date || null, "EPO Register WO application-reference")
    } else {
      throw new Error(
        `EPO Register application-reference: expected EP or WO country, received ${JSON.stringify(country)}`
      )
    }
  }
  return newestByGazette(
    candidates,
    (candidate) => candidate.reference,
    applicationIdSemantic,
    "EPO Register application-reference"
  )
}

function applicationDigits(bib: OpsNode): string | null {
  const current = currentEpApplicationId(bib)
  const value = opsText(current?.id?.["reg:doc-number"])
  const digits = value?.trim().replace(/^EP/i, "")
  return digits && /^\d{8}$/.test(digits) ? digits : null
}

function applicationDigitsFromDocument(
  document: OpsNode,
  context: string
): string {
  const bib = document?.["reg:bibliographic-data"]
  if (!isObject(bib)) throw new Error(`${context}: missing bibliographic-data`)
  const digits = applicationDigits(bib)
  if (!digits)
    throw new Error(`${context}: invalid or missing EP application number`)
  return digits
}

function divisionApplicationDigits(
  document: OpsNode,
  context: string
): string | null {
  const ids = documentIds(document, context)
  if (ids.length === 0) throw new Error(`${context}: missing document-id`)
  const applications: string[] = []
  let emptyIds = 0
  for (const id of ids) {
    const rawType = id["@document-id-type"]
    const type =
      typeof rawType === "string" || typeof rawType === "number"
        ? String(rawType).trim().toLocaleLowerCase("en-US")
        : ""
    const country = (
      strictElementText(id["reg:country"], `${context} country`) ?? ""
    )
      .trim()
      .toUpperCase()
    const digits = (
      strictElementText(id["reg:doc-number"], `${context} doc-number`) ?? ""
    ).trim()
    const kind = (strictElementText(id["reg:kind"], `${context} kind`) ?? "")
      .trim()
      .toUpperCase()
    const rawDate = (
      strictElementText(id["reg:date"], `${context} date`) ?? ""
    ).trim()
    if (!type && !country && !digits && !kind && !rawDate) {
      emptyIds++
      continue
    }
    if (type === "application number") {
      if (country !== "EP" || !/^\d{8}$/.test(digits) || kind !== "D")
        throw new Error(`${context}: invalid EP application-number document-id`)
      strictOpsDate(rawDate || null, `${context} application number`)
      applications.push(digits)
      continue
    }
    if (type === "publication number") {
      if (country !== "EP" || !/^\d{7}$/.test(digits) || kind !== "D")
        throw new Error(`${context}: invalid EP publication-number document-id`)
      strictOpsDate(rawDate || null, `${context} publication number`)
      continue
    }
    throw new Error(
      `${context}: unsupported non-empty document-id type ${JSON.stringify(rawType)}`
    )
  }
  if (emptyIds > 0 && emptyIds !== ids.length)
    throw new Error(`${context}: mixes an empty placeholder with document data`)
  if (emptyIds === ids.length) return null
  if (applications.length !== 1)
    throw new Error(
      `${context}: expected exactly one EP application-number document-id, received ${applications.length}`
    )
  return applications[0]
}

function divisionParents(bib: OpsNode, current: string): string[] {
  const parentsByChild = new Map<string, Set<string>>()
  const addRelation = (parent: string, child: string): void => {
    if (parent === child)
      throw new Error(
        `EPO Register division relation: application ${parent} cannot be its own parent`
      )
    const parents = parentsByChild.get(child) ?? new Set<string>()
    parents.add(parent)
    parentsByChild.set(child, parents)
  }

  for (const related of opsArr(bib["reg:related-documents"])) {
    if (!isObject(related))
      throw new Error("EPO Register result: malformed related-documents")
    for (const division of opsArr(related["reg:division"])) {
      if (!isObject(division))
        throw new Error("EPO Register result: malformed division relation")
      for (const relation of opsArr(division["reg:relation"])) {
        if (!isObject(relation))
          throw new Error("EPO Register result: malformed division relation")
        const parent = divisionApplicationDigits(
          relation["reg:parent-doc"],
          "EPO Register division parent-doc"
        )
        const child = divisionApplicationDigits(
          relation["reg:child-doc"],
          "EPO Register division child-doc"
        )

        if (!parent && !child)
          throw new Error(
            "EPO Register division relation: parent and child are both empty placeholders"
          )

        // Register records use an empty placeholder for whichever side is the
        // current application. Preserve explicit chains when both are present.
        if (parent && child) addRelation(parent, child)
        else if (parent) addRelation(parent, current)
        else if (child) addRelation(current, child)
      }
    }
  }

  const visitedForCycle = new Set<string>()
  const visiting = new Set<string>()
  const visit = (child: string): void => {
    if (visiting.has(child))
      throw new Error(
        `EPO Register division relation: cycle detected at application ${child}`
      )
    if (visitedForCycle.has(child)) return
    visiting.add(child)
    for (const parent of parentsByChild.get(child) ?? []) visit(parent)
    visiting.delete(child)
    visitedForCycle.add(child)
  }
  for (const child of parentsByChild.keys()) visit(child)

  const ancestors = new Set<string>()
  const visited = new Set<string>([current])
  const pending = [current]
  while (pending.length > 0) {
    const child = pending.pop()!
    for (const parent of parentsByChild.get(child) ?? []) {
      if (visited.has(parent)) continue
      visited.add(parent)
      ancestors.add(parent)
      pending.push(parent)
    }
  }
  return [...ancestors].sort()
}

function exactFilingDate(bib: OpsNode): string | null {
  const current = currentEpApplicationId(bib)
  return strictOpsDate(
    opsText(current?.id?.["reg:date"]),
    "EPO Register application-reference"
  )
}

type Publication = {
  country: string
  docNumber: string
  kind: string
  date: string | null
  reference: OpsNode
}

const EP_PUBLICATION_KINDS = new Set([
  "A1",
  "A2",
  "A3",
  "A4",
  "A8",
  "A9",
  "B1",
  "B2",
  "B3",
  "B8",
  "B9",
])
const WO_PUBLICATION_KINDS = new Set(["A1", "A2", "A3", "A4"])

function publications(bib: OpsNode): Publication[] {
  const output: Publication[] = []
  for (const reference of opsArr(bib?.["reg:publication-reference"])) {
    if (!isObject(reference))
      throw new Error("EPO Register result: malformed publication-reference")
    gazetteRank(reference, "EPO Register publication-reference")
    const ids = documentIds(reference, "EPO Register publication-reference")
    if (ids.length !== 1)
      throw new Error(
        `EPO Register publication-reference: expected exactly one document-id, received ${ids.length}`
      )
    const [id] = ids
    const country = (
      strictElementText(
        id["reg:country"],
        "EPO Register publication-reference country"
      ) ?? ""
    )
      .trim()
      .toUpperCase()
    const rawDocNumber = (
      strictElementText(
        id["reg:doc-number"],
        "EPO Register publication-reference doc-number"
      ) ?? ""
    ).trim()
    const kind = (
      strictElementText(
        id["reg:kind"],
        "EPO Register publication-reference kind"
      ) ?? ""
    )
      .trim()
      .toUpperCase()
    if (country !== "EP" && country !== "WO")
      throw new Error(
        `EPO Register publication-reference: expected EP or WO country, received ${JSON.stringify(country)}`
      )
    const allowedKinds =
      country === "EP" ? EP_PUBLICATION_KINDS : WO_PUBLICATION_KINDS
    if (!allowedKinds.has(kind))
      throw new Error(
        `EPO Register publication-reference: invalid ${country} kind ${JSON.stringify(kind)}`
      )
    // The Register contract requires a document-id and does not document an
    // empty publication-number tombstone. Reject one at any gazette rank so it
    // cannot be ignored and accidentally revive an older publication value.
    if (!rawDocNumber)
      throw new Error(
        "EPO Register publication-reference: document-id has no publication number"
      )
    if (
      rawDocNumber &&
      (country === "EP"
        ? !/^\d{7}$/.test(rawDocNumber)
        : !/^\d{7,12}$/.test(rawDocNumber))
    )
      throw new Error(
        `EPO Register publication-reference: invalid ${country} publication number ${JSON.stringify(rawDocNumber)}`
      )
    output.push({
      country,
      docNumber: rawDocNumber,
      kind,
      date: strictOpsDate(
        strictElementText(
          id["reg:date"],
          "EPO Register publication-reference date"
        ),
        `EPO Register ${country} ${kind}`
      ),
      reference,
    })
  }
  return output
}

function officeDocumentNumber(country: string, docNumber: string): string {
  return docNumber.toUpperCase().startsWith(country)
    ? `${country}${docNumber.slice(country.length)}`
    : `${country}${docNumber}`
}

const EP_STATUS_BY_CODE: Readonly<Record<string, string>> = {
  "0": "Unknown",
  "1": "Patent revoked by proprietor",
  "2": "The patent has been limited",
  "3": "Patent maintained as amended",
  "4": "Patent revoked",
  "5": "Opposition rejected",
  "6": "Opposition procedure closed",
  "7": "No opposition filed within time limit",
  "8": "The patent has been granted",
  "9": "The application has been withdrawn",
  "10": "The application is deemed to be withdrawn",
  "11": "The application has been refused",
  "12": "Grant of patent is intended",
  "13.1": "Proceedings closed following consolidation with another application",
  "13.2": "Proceedings closed following consolidation with another application",
  "14": "Examination is in progress",
  "15": "Request for examination was made",
  "16": "The application has been published",
  "17": "The international publication has been made",
}

type PatentStatusEvent = {
  status: string
  changeDate: string
  index: number
}

function patentStatusEvents(
  document: OpsNode,
  bib: OpsNode
): PatentStatusEvent[] {
  const rawContainers =
    document?.["reg:ep-patent-statuses"] ?? bib?.["reg:ep-patent-statuses"]
  if (rawContainers == null)
    throw new Error("EPO Register result: missing ep-patent-statuses")
  const containers = opsArr(rawContainers)
  const rawEvents = containers.flatMap((container) => {
    if (!isObject(container))
      throw new Error("EPO Register result: malformed ep-patent-statuses")
    return opsArr(container["reg:ep-patent-status"])
  })
  if (rawEvents.length === 0)
    throw new Error("EPO Register result: empty ep-patent-statuses")
  return rawEvents.map((event, index) => {
    if (!isObject(event))
      throw new Error("EPO Register result: malformed ep-patent-status")
    const codeValue = event["@status-code"]
    const code =
      typeof codeValue === "string" || typeof codeValue === "number"
        ? String(codeValue).trim()
        : null
    if (!code)
      throw new Error(
        "EPO Register result: ep-patent-status has no status-code"
      )
    const providedStatus = Object.prototype.hasOwnProperty.call(event, "$")
      ? strictElementText(event, "EPO Register ep-patent-status text")?.trim()
      : null
    const knownStatus = EP_STATUS_BY_CODE[code]
    if (
      knownStatus &&
      providedStatus &&
      statusCategory(knownStatus) !== statusCategory(providedStatus)
    )
      throw new Error(
        `EPO Register result: status code ${code} contradicts text ${JSON.stringify(providedStatus)}`
      )
    const status = knownStatus ?? providedStatus
    if (!status)
      throw new Error("EPO Register result: ep-patent-status has no status")
    const changeDateValue = event["@change-date"]
    const changeDate = strictOpsDate(
      typeof changeDateValue === "string" || typeof changeDateValue === "number"
        ? String(changeDateValue)
        : null,
      "EPO Register ep-patent-status change-date"
    )
    if (!changeDate)
      throw new Error(
        "EPO Register result: ep-patent-status has no change-date"
      )
    return { status, changeDate, index }
  })
}

function normalizedStatus(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US")
}

function statusCategory(value: string): string {
  const normalized = normalizedStatus(value)
  if (/deemed.*withdraw/.test(normalized)) return "deemed-withdrawn"
  if (/withdraw/.test(normalized)) return "withdrawn"
  if (/refus/.test(normalized)) return "refused"
  if (/revok.*proprietor/.test(normalized)) return "revoked-proprietor"
  if (/revok/.test(normalized)) return "revoked"
  if (/maintain.*amend/.test(normalized)) return "maintained-amended"
  if (/limit/.test(normalized)) return "limited"
  if (/grant.*intend/.test(normalized)) return "grant-intended"
  if (/grant/.test(normalized)) return "granted"
  if (/no opposition/.test(normalized)) return "no-opposition"
  if (/opposition.*reject/.test(normalized)) return "opposition-rejected"
  if (/opposition.*clos/.test(normalized)) return "opposition-closed"
  if (/consolidat/.test(normalized)) return "consolidated"
  if (/international.*publish/.test(normalized))
    return "international-published"
  if (/publish/.test(normalized)) return "published"
  if (/examin.*progress/.test(normalized)) return "examination"
  return normalized
}

function latestStatusEvent(
  events: PatentStatusEvent[]
): PatentStatusEvent | null {
  return (
    [...events]
      .sort((left, right) => {
        const dateOrder = (left.changeDate ?? "").localeCompare(
          right.changeDate ?? ""
        )
        return dateOrder || left.index - right.index
      })
      .at(-1) ?? null
  )
}

function currentStatus(
  document: OpsNode,
  bib: OpsNode
): { status: string | null; changeDate: string | null } {
  const events = patentStatusEvents(document, bib)
  if (document?.["@status"] != null && typeof document["@status"] !== "string")
    throw new Error("EPO Register result: malformed document status")
  const documentStatus =
    typeof document?.["@status"] === "string"
      ? document["@status"].trim() || null
      : null
  if (documentStatus) {
    const normalizedDocumentStatus = normalizedStatus(documentStatus)
    const category = statusCategory(documentStatus)
    const matching = events.filter(
      (event) =>
        normalizedStatus(event.status) === normalizedDocumentStatus ||
        statusCategory(event.status) === category
    )
    return {
      status: documentStatus,
      changeDate: latestStatusEvent(matching)?.changeDate ?? null,
    }
  }
  const latestEvent = latestStatusEvent(events)
  if (latestEvent)
    return { status: latestEvent.status, changeDate: latestEvent.changeDate }
  const bibliographicStatus =
    typeof bib?.["@status"] === "string" ? bib["@status"].trim() : ""
  return { status: bibliographicStatus || null, changeDate: null }
}

function publicationKindRank(kind: string, prefix: "A" | "B"): number {
  const preferred =
    prefix === "A"
      ? ["A1", "A2", "A3", "A4", "A8", "A9"]
      : ["B1", "B2", "B3", "B8", "B9"]
  const index = preferred.indexOf(kind)
  return index === -1 ? preferred.length : index
}

function preferredPublication(
  publicationRefs: Publication[],
  prefix: "A" | "B"
): Publication | null {
  const grouped = new Map<string, Publication[]>()
  for (const publication of publicationRefs) {
    const key = `${publication.country}\u0000${publication.kind}`
    const values = grouped.get(key) ?? []
    values.push(publication)
    grouped.set(key, values)
  }
  const corrected = [...grouped.entries()].map(([key, values]) =>
    newestByGazette(
      values,
      (publication) => publication.reference,
      (publication) =>
        JSON.stringify([
          publication.country,
          publication.docNumber,
          publication.kind,
          publication.date,
        ]),
      `EPO Register publication ${key.replace("\u0000", " ")}`
    )
  )
  return (
    corrected
      .filter((publication): publication is Publication => publication !== null)
      .filter(
        (publication) =>
          publication.country === "EP" &&
          publication.kind.startsWith(prefix) &&
          publication.docNumber
      )
      .sort((left, right) => {
        const rank =
          publicationKindRank(left.kind, prefix) -
          publicationKindRank(right.kind, prefix)
        return (
          rank ||
          (left.date ?? "9999-99-99").localeCompare(right.date ?? "9999-99-99")
        )
      })[0] ?? null
  )
}

function eventDate(node: OpsNode, context: string): string | null {
  const candidates = opsArr(node)
  const current = newestByGazette(
    candidates,
    (candidate) => candidate,
    (candidate) =>
      JSON.stringify(
        (opsText(candidate?.["reg:date"]) ?? opsText(candidate) ?? "").trim() ||
          null
      ),
    context
  )
  return strictOpsDate(
    opsText(current?.["reg:date"]) ?? opsText(current),
    context
  )
}

function matchingStatusDate(
  bib: OpsNode,
  status: string | null,
  grantDate: string | null
): string | null {
  if (!status) return null
  if (/deemed.*withdraw/i.test(status))
    return eventDate(
      bib["reg:date-application-deemed-withdrawn"],
      "EPO Register deemed-withdrawn date"
    )
  if (/withdraw/i.test(status))
    return eventDate(
      bib["reg:date-application-withdrawn-by-applicant"],
      "EPO Register withdrawn date"
    )
  if (/refus/i.test(status))
    return eventDate(
      bib["reg:date-application-refused"],
      "EPO Register refusal date"
    )
  if (/revok/i.test(status))
    return eventDate(
      bib["reg:date-of-revocation"],
      "EPO Register revocation date"
    )
  if (/grant/i.test(status) && !/intend/i.test(status)) return grantDate
  return null
}

function currentInventionTitle(bib: OpsNode): string | null {
  const titles = opsArr(bib["reg:invention-title"])
  if (titles.length === 0) return null
  const language = (title: OpsNode): string =>
    typeof title?.["@lang"] === "string"
      ? title["@lang"].trim().toLocaleLowerCase("en-US")
      : ""
  const english = titles.filter((title) => language(title) === "en")
  const preferredLanguage = english.length > 0 ? "en" : language(titles[0])
  const sameLanguage = titles.filter(
    (title) => language(title) === preferredLanguage
  )
  const current = newestByGazette(
    sameLanguage,
    (title) => title,
    (title) => JSON.stringify(opsText(title)?.trim() || null),
    `EPO Register ${preferredLanguage || "default-language"} invention title`
  )
  return opsText(current)?.trim() || null
}

function recordFromRegisterDocument(document: OpsNode): PatentRecord {
  const bib = document?.["reg:bibliographic-data"]
  if (!isObject(bib))
    throw new Error("EPO Register result: missing bibliographic-data")
  const digits = applicationDigitsFromDocument(document, "EPO Register result")

  const filingDate = exactFilingDate(bib)
  const publicationRefs = publications(bib)
  const patentDocument = preferredPublication(publicationRefs, "B")
  const originalGrant = patentDocument?.kind === "B1" ? patentDocument : null
  const epPublication =
    preferredPublication(publicationRefs, "A") ??
    publicationRefs.find((publication) => publication.country === "EP")
  const hasInternationalOrigin =
    publicationRefs.some((publication) => publication.country === "WO") ||
    opsArr(bib["reg:pct-or-regional-filing-data"]).length > 0
  const resolvedStatus = currentStatus(document, bib)
  const status = resolvedStatus.status
  const title = currentInventionTitle(bib)
  const parents = divisionParents(bib, digits)

  return {
    source: "EPO",
    jurisdiction: "EP",
    applicationNumber: digits,
    title: title ?? `EP${digits}`,
    type:
      parents.length > 0
        ? "Divisional"
        : hasInternationalOrigin
          ? "Regional Phase"
          : "Original",
    filingDate,
    status,
    // A publication or examination date is not a status-change date. The
    // B-publication date is used only when it matches a granted status.
    statusDate:
      resolvedStatus.changeDate ??
      matchingStatusDate(bib, status, originalGrant?.date ?? null),
    grantDate: originalGrant?.date ?? null,
    patentNumber: patentDocument?.docNumber
      ? officeDocumentNumber("EP", patentDocument.docNumber)
      : null,
    publicationNumber: epPublication?.docNumber
      ? officeDocumentNumber("EP", epPublication.docNumber)
      : null,
    // Baseline EP term only; this does not imply present enforceability.
    // SPCs, term extensions, lapses, and other legal events are not
    // incorporated into this estimate.
    estExpiry:
      originalGrant?.date && filingDate ? addYears(filingDate, 20) : null,
    parents,
  }
}

// OPS returns Register search results in Range pages (up to 100 requested
// here). Completion is governed by the reported total plus the shared request
// and wall-clock budgets; any inability to retrieve that total fails closed.
const OPS_SEARCH_PAGE = 100
// OPS does not publish a Register-specific POST maximum. Keep batches at 100,
// the documented bulk ceiling for other OPS retrieval services, so request
// size and failure scope remain bounded.
const OPS_REGISTER_BATCH = 100
const REGISTER_BIBLIO_PATH = "/register/application/epodoc/biblio"

async function searchByApplicant(
  applicant: string,
  session: OpsSession
): Promise<string[]> {
  const query = encodeURIComponent(`pa="${applicant}"`)
  const output: string[] = []
  const pageSignatures = new Set<string>()
  const seenApplications = new Set<string>()
  let start = 1
  let expectedTotal: number | null = null

  while (expectedTotal == null || output.length < expectedTotal) {
    const context = `EPO Register search for "${applicant}" at ${start}`
    const raw = await opsGet(`/register/search/biblio?q=${query}`, session, {
      Range: `${start}-${start + OPS_SEARCH_PAGE - 1}`,
    })
    const search = registerSearch(raw, context)
    const total = totalResultCount(search, context)
    if (expectedTotal == null) expectedTotal = total
    else if (total !== expectedTotal)
      throw new Error(
        `${context}: result count changed from ${expectedTotal} to ${total} during pagination`
      )

    const documents = registerDocuments(search, context)
    if (documents.length > OPS_SEARCH_PAGE)
      throw new Error(`${context}: response exceeded requested page size`)
    if (expectedTotal === 0) {
      if (documents.length !== 0)
        throw new Error(
          `${context}: zero total accompanied by result documents`
        )
      break
    }
    if (documents.length === 0)
      throw new Error(
        `${context}: empty page before the reported total was exhausted`
      )

    const applications = documents.map((document) =>
      applicationDigitsFromDocument(document, context)
    )
    const signature = applications.join("|")
    if (pageSignatures.has(signature))
      throw new Error(
        `${context}: repeated result page; pagination made no progress`
      )
    pageSignatures.add(signature)
    for (const application of applications) {
      if (seenApplications.has(application))
        throw new Error(
          `${context}: duplicate application ${application} across result pages`
        )
      seenApplications.add(application)
    }
    output.push(...applications)
    if (output.length > expectedTotal)
      throw new Error(
        `${context}: received more documents than the reported total`
      )
    start += documents.length
  }

  if (expectedTotal == null || output.length !== expectedTotal)
    throw new Error(
      `EPO Register search for "${applicant}": received ${output.length} of ${expectedTotal ?? "unknown"} reported results`
    )
  return output
}

async function fetchRegisterBatch(
  applications: string[],
  session: OpsSession
): Promise<PatentRecord[]> {
  if (applications.length === 0) return []
  if (applications.length > OPS_REGISTER_BATCH)
    throw new Error(
      `EPO Register batch exceeds the ${OPS_REGISTER_BATCH}-application client limit`
    )
  const requested = new Set(applications)
  if (requested.size !== applications.length)
    throw new Error("EPO Register batch contains duplicate application numbers")

  const context = `EPO Register biblio batch (${applications.length} applications)`
  const body = applications.map((digits) => `EP${digits}`).join("\n")
  const raw = await opsPost(REGISTER_BIBLIO_PATH, session, body, {
    "Content-Type": "text/plain",
  })
  const search = registerSearch(raw, context)
  const total = totalResultCount(search, context)
  const documents = registerDocuments(search, context)
  if (total !== applications.length || documents.length !== applications.length)
    throw new Error(
      `${context}: requested ${applications.length}, but OPS reported ${total} and returned ${documents.length}`
    )

  const byApplication = new Map<string, PatentRecord>()
  for (const document of documents) {
    const record = recordFromRegisterDocument(document)
    if (!requested.has(record.applicationNumber))
      throw new Error(
        `${context}: returned unexpected application ${record.applicationNumber}`
      )
    if (byApplication.has(record.applicationNumber))
      throw new Error(
        `${context}: returned duplicate application ${record.applicationNumber}`
      )
    byApplication.set(record.applicationNumber, record)
  }
  const missing = applications.filter(
    (application) => !byApplication.has(application)
  )
  if (missing.length > 0)
    throw new Error(
      `${context}: missing requested applications ${missing.join(", ")}`
    )
  return applications.map((application) => byApplication.get(application)!)
}

// Fetch EP records for the given applicant name(s). `pace` is the pacer's
// wait(), called before every network request made by this adapter.
export async function fetchEpoRecords(
  applicants: string[],
  pace: () => Promise<void>,
  deadlineMs = Number.POSITIVE_INFINITY
): Promise<PatentRecord[]> {
  if (deadlineMs !== Number.POSITIVE_INFINITY && !Number.isFinite(deadlineMs))
    throw new Error("EPO OPS acquisition deadline must be finite or Infinity")
  const session: OpsSession = { pace, deadlineMs, requestCount: 0 }
  const applications = new Set<string>()
  for (const applicant of normalizedApplicants(applicants)) {
    for (const application of await searchByApplicant(applicant, session))
      applications.add(application)
  }

  const records: PatentRecord[] = []
  const discovered = [...applications]
  for (let index = 0; index < discovered.length; index += OPS_REGISTER_BATCH) {
    records.push(
      ...(await fetchRegisterBatch(
        discovered.slice(index, index + OPS_REGISTER_BATCH),
        session
      ))
    )
  }
  return records
}

// Exercise both discovery and authoritative full-record retrieval for one
// stable public application. A search-only probe can succeed while the batch
// endpoint used by the portfolio is unavailable or structurally incompatible.
export async function probeEpo(pace: () => Promise<void>): Promise<void> {
  const application = "99203729"
  const query = encodeURIComponent(`ap=EP${application}`)
  const context = "EPO Register health probe search"
  const session: OpsSession = {
    pace,
    deadlineMs: Number.POSITIVE_INFINITY,
    requestCount: 0,
  }
  const raw = await opsGet(`/register/search/biblio?q=${query}`, session, {
    Range: "1-1",
  })
  const search = registerSearch(raw, context)
  const total = totalResultCount(search, context)
  const documents = registerDocuments(search, context)
  if (total !== 1 || documents.length !== 1)
    throw new Error(
      `${context}: expected exactly one stable application, reported ${total} and returned ${documents.length}`
    )
  const returned = applicationDigitsFromDocument(documents[0], context)
  if (returned !== application)
    throw new Error(`${context}: returned unexpected application ${returned}`)
  const records = await fetchRegisterBatch([application], session)
  if (records.length !== 1 || records[0]?.applicationNumber !== application)
    throw new Error("EPO Register health probe batch returned the wrong record")
}

function addYears(date: string, years: number): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return null
  const [, yearText, monthText, dayText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  if (!isValidDateParts(year, month, day)) return null
  const targetYear = year + years
  if (month === 2 && day === 29 && !isLeapYear(targetYear))
    return `${String(targetYear).padStart(4, "0")}-02-28`
  return `${String(targetYear).padStart(4, "0")}-${monthText}-${dayText}`
}
