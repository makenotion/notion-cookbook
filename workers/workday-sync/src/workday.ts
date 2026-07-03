// Employee-directory Workday Human Resources WWS client.
//
// Workday recommends SOAP for scheduled, high-volume system-to-system reads.
// Get_Workers is requested as a pinned snapshot with broad HR sections off.
// People pages add one batched Get_Change_Work_Contact_Information request and
// retain only the public primary WORK email. Raw source payloads are never
// written to Notion, state, or logs.

import { createHash, createHmac, randomUUID } from "node:crypto"

import { RateLimitError } from "@notionhq/workers"
import { XMLParser, XMLValidator } from "fast-xml-parser"

import type { DirectoryPerson } from "./people.js"
import {
  DIRECTORY_FINGERPRINT_BYTES,
  DIRECTORY_SYNC_CONTRACT_VERSION,
  WORKDAY_PAGE_SIZE,
  type WorkdayDirectoryClient,
  type WorkdayDirectoryProjection,
  type WorkdayPageRequest,
  type WorkdayWorkersPage,
} from "./sync.js"
import { normalizedWorkEmail, validatePageRequest } from "./validation.js"

export { WORKDAY_PAGE_SIZE } from "./sync.js"

export const DEFAULT_WORKDAY_WWS_VERSION = "v46.1"
export const WORKDAY_REQUEST_TIMEOUT_MS = 60_000
export const WORKDAY_TOKEN_MAX_RESPONSE_BYTES = 64 * 1_024
export const WORKDAY_SOAP_MAX_RESPONSE_BYTES = 5 * 1_024 * 1_024

export type BeforeRequest = () => Promise<void>
export type FetchImplementation = typeof fetch

export type WorkdayConfig = {
  apiUrl: string
  apiVersion: string
  tokenUrl: string
  clientId: string
  clientSecret: string
  refreshToken: string
  effectiveTimeZone: string
  externalApplicationId?: string
}

export type WorkdayTokenProvider = {
  getAccessToken(): Promise<string>
  invalidate(accessToken: string): void
}

type JsonObject = Record<string, unknown>

function requiredEnv(
  env: NodeJS.ProcessEnv,
  name: keyof NodeJS.ProcessEnv
): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is not set.`)
  return value
}

function normalizeHttpsEndpoint(raw: string, name: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL.`)
  }

  if (
    url.protocol !== "https:" ||
    (url.port !== "" && url.port !== "443") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !isWorkdayHostname(url.hostname)
  ) {
    throw new Error(
      `${name} must be a Workday-hosted HTTPS URL without credentials.`
    )
  }
  return url
}

function isWorkdayHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "")
  const domains = [
    "workday.com",
    "myworkday.com",
    "myworkdaysuv.com",
    "workdaysuv.com",
    "workdaygov.com",
  ]
  return domains.some(
    (domain) => normalized === domain || normalized.endsWith(`.${domain}`)
  )
}

export function getWorkdayConfig(
  env: NodeJS.ProcessEnv = process.env
): WorkdayConfig {
  const apiVersion =
    env.WORKDAY_API_VERSION?.trim() || DEFAULT_WORKDAY_WWS_VERSION
  if (!/^v\d+\.\d+$/.test(apiVersion)) {
    throw new Error("WORKDAY_API_VERSION must look like v46.1.")
  }

  const apiUrl = normalizeHttpsEndpoint(
    requiredEnv(env, "WORKDAY_API_URL"),
    "WORKDAY_API_URL"
  )
  const apiPath = apiUrl.pathname.replace(/\/+$/, "")
  const tenantPath = new RegExp(
    `^/ccx/service/([^/]+)/Human_Resources/${apiVersion.replace(".", "\\.")}$`
  )
  const tenantMatch = tenantPath.exec(apiPath)
  if (!tenantMatch) {
    throw new Error(
      "WORKDAY_API_URL must be the pinned tenant Human_Resources SOAP endpoint."
    )
  }

  const tokenUrl = normalizeHttpsEndpoint(
    requiredEnv(env, "WORKDAY_TOKEN_URL"),
    "WORKDAY_TOKEN_URL"
  )
  if (!tokenUrl.pathname.replace(/\/+$/, "").endsWith("/token")) {
    throw new Error("WORKDAY_TOKEN_URL must be a Workday token endpoint.")
  }
  const tenant = tenantMatch[1]
  const escapedTenant = tenant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const expectedTokenPath = new RegExp(
    `^(?:/ccx)?/oauth2/${escapedTenant}/token$`
  )
  if (
    tokenUrl.origin !== apiUrl.origin ||
    !expectedTokenPath.test(tokenUrl.pathname.replace(/\/+$/, ""))
  ) {
    throw new Error(
      "WORKDAY_TOKEN_URL must be the matching tenant OAuth token endpoint."
    )
  }

  const effectiveTimeZone = requiredEnv(env, "WORKDAY_EFFECTIVE_TIME_ZONE")
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: effectiveTimeZone })
  } catch {
    throw new Error("WORKDAY_EFFECTIVE_TIME_ZONE must be a valid IANA zone.")
  }

  const externalApplicationId = env.WORKDAY_EXTERNAL_APPLICATION_ID?.trim()
  if (externalApplicationId) {
    try {
      if (externalApplicationId.length > 50) throw new Error()
      new Headers({ "wd-external-application-id": externalApplicationId })
    } catch {
      throw new Error(
        "WORKDAY_EXTERNAL_APPLICATION_ID must be a valid HTTP header value of at most 50 characters."
      )
    }
  }

  return {
    apiUrl: apiUrl.toString(),
    apiVersion,
    tokenUrl: tokenUrl.toString(),
    clientId: requiredEnv(env, "WORKDAY_CLIENT_ID"),
    clientSecret: requiredEnv(env, "WORKDAY_CLIENT_SECRET"),
    refreshToken: requiredEnv(env, "WORKDAY_REFRESH_TOKEN"),
    effectiveTimeZone,
    ...(externalApplicationId ? { externalApplicationId } : {}),
  }
}

export function parseRetryAfterSeconds(
  value: string | null,
  now = Date.now()
): number | undefined {
  const normalized = value?.trim()
  if (!normalized) return undefined

  const seconds = Number(normalized)
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? Math.ceil(seconds) : undefined
  }

  const retryAt = Date.parse(normalized)
  if (!Number.isFinite(retryAt)) return undefined
  return Math.max(0, Math.ceil((retryAt - now) / 1_000))
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function jsonObject(value: unknown): JsonObject {
  return isObject(value) ? value : {}
}

function parseTokenResponse(text: string): JsonObject {
  try {
    return jsonObject(JSON.parse(text) as unknown)
  } catch {
    return {}
  }
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  label: string
): Promise<string> {
  const contentLength = response.headers.get("content-length")?.trim()
  if (
    contentLength &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > maxBytes
  ) {
    throw new Error(`${label} response exceeded the allowed size.`)
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
      if (bytesRead > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`${label} response exceeded the allowed size.`)
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
  } finally {
    reader.releaseLock()
  }

  chunks.push(decoder.decode())
  return chunks.join("")
}

export function createWorkdayTokenProvider(
  config: WorkdayConfig,
  beforeRequest: BeforeRequest,
  fetchImplementation: FetchImplementation = fetch
): WorkdayTokenProvider {
  let current: string | undefined
  let pending: Promise<string> | undefined

  async function requestAccessToken(): Promise<string> {
    await beforeRequest()
    let response: Response
    try {
      response = await fetchImplementation(config.tokenUrl, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${config.clientId}:${config.clientSecret}`
          ).toString("base64")}`,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: config.refreshToken,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(WORKDAY_REQUEST_TIMEOUT_MS),
      })
    } catch {
      throw new Error(
        "Workday OAuth request failed before receiving a response."
      )
    }

    const text = await readBoundedResponseText(
      response,
      WORKDAY_TOKEN_MAX_RESPONSE_BYTES,
      "Workday OAuth"
    )
    if ([429, 502, 503, 504].includes(response.status)) {
      throw new RateLimitError({
        retryAfter: parseRetryAfterSeconds(response.headers.get("retry-after")),
      })
    }
    if (!response.ok) {
      throw new Error(`Workday OAuth request failed (${response.status}).`)
    }

    const token = parseTokenResponse(text)
    const accessToken = token.access_token
    const tokenType = token.token_type
    if (typeof accessToken !== "string" || !accessToken.trim()) {
      throw new Error("Workday OAuth response is missing access_token.")
    }
    if (
      tokenType !== undefined &&
      (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer")
    ) {
      throw new Error(
        "Workday OAuth response returned an unsupported token type."
      )
    }
    return accessToken
  }

  return {
    async getAccessToken() {
      if (current) return current

      pending ??= requestAccessToken()
        .then((accessToken) => {
          current = accessToken
          return accessToken
        })
        .finally(() => {
          pending = undefined
        })
      return pending
    },
    invalidate(accessToken) {
      if (current === accessToken) current = undefined
    },
  }
}

function xmlElement(name: string, value: boolean | string | number): string {
  return `<bsvc:${name}>${String(value)}</bsvc:${name}>`
}

/**
 * Keep this list explicit. An empty Response_Group makes Workday return broad
 * personal, compensation, organization, and role sections by default.
 */
export function buildGetWorkersRequest(
  version: string,
  request: WorkdayPageRequest,
  projection: WorkdayDirectoryProjection
): string {
  if (!/^v\d+\.\d+$/.test(version)) {
    throw new Error("Workday SOAP version is invalid.")
  }
  validatePageRequest(request)

  const responseGroup = [
    xmlElement("Include_Reference", true),
    xmlElement("Include_Personal_Information", false),
    xmlElement("Show_All_Personal_Information", false),
    xmlElement("Include_Additional_Jobs", false),
    xmlElement("Include_Employment_Information", false),
    xmlElement("Include_Compensation", false),
    xmlElement("Include_Organizations", true),
    xmlElement("Exclude_Organization_Support_Role_Data", true),
    xmlElement("Exclude_Location_Hierarchies", true),
    xmlElement("Exclude_Cost_Centers", true),
    xmlElement("Exclude_Cost_Center_Hierarchies", true),
    xmlElement("Exclude_Companies", true),
    xmlElement("Exclude_Company_Hierarchies", true),
    xmlElement("Exclude_Matrix_Organizations", true),
    xmlElement("Exclude_Pay_Groups", true),
    xmlElement("Exclude_Regions", true),
    xmlElement("Exclude_Region_Hierarchies", true),
    xmlElement("Exclude_Supervisory_Organizations", false),
    xmlElement("Exclude_Teams", true),
    xmlElement("Exclude_Custom_Organizations", true),
    xmlElement("Include_Roles", false),
    xmlElement("Include_Management_Chain_Data", projection === "people"),
    xmlElement(
      "Include_Multiple_Managers_in_Management_Chain_Data",
      projection === "people"
    ),
    xmlElement("Include_Benefit_Enrollments", false),
    xmlElement("Include_Benefit_Eligibility", false),
    xmlElement("Include_Related_Persons", false),
    xmlElement("Include_Qualifications", false),
    xmlElement("Include_Employee_Review", false),
    xmlElement("Include_Goals", false),
    xmlElement("Include_Development_Items", false),
    xmlElement("Include_Skills", false),
    xmlElement("Include_Photo", false),
    xmlElement("Include_Worker_Documents", false),
    xmlElement("Include_Transaction_Log_Data", false),
    xmlElement("Include_Subevents_for_Corrected_Transaction", false),
    xmlElement("Include_Subevents_for_Rescinded_Transaction", false),
    xmlElement("Include_Succession_Profile", false),
    xmlElement("Include_Talent_Assessment", false),
    xmlElement("Include_Employee_Contract_Data", false),
    xmlElement("Include_Contracts_for_Terminated_Workers", false),
    xmlElement("Include_Collective_Agreement_Data", false),
    xmlElement("Include_Probation_Period_Data", false),
    xmlElement("Include_Extended_Employee_Contract_Details", false),
    xmlElement("Include_Feedback_Received", false),
    xmlElement("Include_User_Account", false),
    xmlElement("Include_Career", false),
    xmlElement("Include_Account_Provisioning", false),
    xmlElement("Include_Background_Check_Data", false),
    xmlElement(
      "Include_Contingent_Worker_Tax_Authority_Form_Information",
      false
    ),
    xmlElement("Exclude_Funds", true),
    xmlElement("Exclude_Fund_Hierarchies", true),
    xmlElement("Exclude_Grants", true),
    xmlElement("Exclude_Grant_Hierarchies", true),
    xmlElement("Exclude_Business_Units", true),
    xmlElement("Exclude_Business_Unit_Hierarchies", true),
    xmlElement("Exclude_Programs", true),
    xmlElement("Exclude_Program_Hierarchies", true),
    xmlElement("Exclude_Gifts", true),
    xmlElement("Exclude_Gift_Hierarchies", true),
    xmlElement("Exclude_Retiree_Organizations", true),
  ].join("")

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:bsvc="urn:com.workday/bsvc">',
    "<soapenv:Header/>",
    "<soapenv:Body>",
    `<bsvc:Get_Workers_Request bsvc:version="${version}">`,
    "<bsvc:Request_Criteria>",
    xmlElement("Exclude_Inactive_Workers", true),
    xmlElement("Exclude_Employees", false),
    xmlElement("Exclude_Contingent_Workers", true),
    "</bsvc:Request_Criteria>",
    "<bsvc:Response_Filter>",
    xmlElement("As_Of_Effective_Date", request.asOfEffectiveDate),
    xmlElement("As_Of_Entry_DateTime", request.asOfEntryDateTime),
    xmlElement("Page", request.page),
    xmlElement("Count", WORKDAY_PAGE_SIZE),
    "</bsvc:Response_Filter>",
    `<bsvc:Response_Group>${responseGroup}</bsvc:Response_Group>`,
    "</bsvc:Get_Workers_Request>",
    "</soapenv:Body>",
    "</soapenv:Envelope>",
  ].join("")
}

function xmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

export function buildGetWorkContactRequest(
  version: string,
  request: WorkdayPageRequest,
  workdayWids: string[]
): string {
  if (!/^v\d+\.\d+$/.test(version)) {
    throw new Error("Workday SOAP version is invalid.")
  }
  validatePageRequest(request)
  const normalizedWids = workdayWids.map((wid) => wid.trim())
  if (
    normalizedWids.length === 0 ||
    normalizedWids.length > WORKDAY_PAGE_SIZE ||
    new Set(normalizedWids).size !== normalizedWids.length ||
    normalizedWids.some((wid) => !wid)
  ) {
    throw new Error("Workday contact request has invalid worker references.")
  }

  const references = normalizedWids
    .map(
      (wid) =>
        `<bsvc:Person_Reference><bsvc:ID bsvc:type="WID">${xmlText(wid)}</bsvc:ID></bsvc:Person_Reference>`
    )
    .join("")

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:bsvc="urn:com.workday/bsvc">',
    "<soapenv:Header/>",
    "<soapenv:Body>",
    `<bsvc:Get_Change_Work_Contact_Information_Request bsvc:version="${version}">`,
    `<bsvc:Request_References>${references}</bsvc:Request_References>`,
    "<bsvc:Response_Filter>",
    xmlElement("As_Of_Effective_Date", request.asOfEffectiveDate),
    xmlElement("As_Of_Entry_DateTime", request.asOfEntryDateTime),
    xmlElement("Page", 1),
    xmlElement("Count", WORKDAY_PAGE_SIZE),
    "</bsvc:Response_Filter>",
    "</bsvc:Get_Change_Work_Contact_Information_Request>",
    "</soapenv:Body>",
    "</soapenv:Envelope>",
  ].join("")
}

function asObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new Error(`Workday response is missing ${label}.`)
  return value
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function valueText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined
  if (typeof value === "number") return String(value)
  if (!isObject(value)) return undefined
  return valueText(value["#text"])
}

function requiredText(value: unknown, label: string): string {
  const text = valueText(value)
  if (!text) throw new Error(`Workday response is missing ${label}.`)
  return text
}

function responseInteger(value: unknown, label: string): number {
  const text = requiredText(value, label)
  if (!/^\d+$/.test(text)) {
    throw new Error(`Workday response has an invalid ${label}.`)
  }
  const number = Number(text)
  if (!Number.isSafeInteger(number)) {
    throw new Error(`Workday response has an invalid ${label}.`)
  }
  return number
}

function referenceId(
  value: unknown,
  idType: string,
  label: string
): string | undefined {
  if (!isObject(value)) return undefined
  const candidates = asArray(value.ID).filter(
    (candidate) => isObject(candidate) && candidate["@type"] === idType
  )
  if (candidates.length > 1) {
    throw new Error(`Workday response has a duplicate ${label} ID type.`)
  }
  if (candidates.length === 0) return undefined
  return requiredText(candidates[0], `${label} ${idType}`)
}

function referenceWid(value: unknown, label: string): string {
  const wid = referenceId(value, "WID", label)
  if (!wid) throw new Error(`Workday response is missing ${label} WID.`)
  return wid
}

function referenceHasIdType(value: unknown, idType: string): boolean {
  return referenceId(value, idType, "reference") !== undefined
}

function booleanAttribute(value: unknown, label: string): boolean {
  if (value === undefined) return false
  if (value === true || value === "true" || value === "1") return true
  if (value === false || value === "false" || value === "0") return false
  throw new Error(`Workday response has an invalid ${label}.`)
}

function isPublicPrimaryWorkUsage(value: unknown): boolean {
  const usage = asObject(value, "email Usage_Data")
  if (!booleanAttribute(usage["@Public"], "email Public attribute")) {
    return false
  }

  for (const typeValue of asArray(usage.Type_Data)) {
    const type = asObject(typeValue, "email Type_Data")
    if (!booleanAttribute(type["@Primary"], "email Primary attribute")) {
      continue
    }
    const usageType = referenceId(
      type.Type_Reference,
      "Communication_Usage_Type_ID",
      "email usage type"
    )
    if (!usageType) {
      throw new Error(
        "Workday response cannot classify a public primary email usage."
      )
    }
    if (usageType === "WORK") return true
  }
  return false
}

function publicPrimaryWorkEmail(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const emailInformation = asObject(value, "Person_Email_Information_Data")
  const candidates = asArray(emailInformation.Email_Information_Data).filter(
    (value) => {
      const email = asObject(value, "Email_Information_Data")
      return asArray(email.Usage_Data).some(isPublicPrimaryWorkUsage)
    }
  )
  if (candidates.length > 1) {
    throw new Error(
      "Workday response has multiple public primary work email addresses."
    )
  }
  if (candidates.length === 0) return undefined

  const email = asObject(candidates[0], "Email_Information_Data")
  const emailData = asArray(email.Email_Data)
  if (emailData.length !== 1) {
    throw new Error("Workday response has invalid work email data.")
  }
  const core = asObject(emailData[0], "Email_Data")
  return normalizedWorkEmail(
    requiredText(core.Email_Address, "public primary work email"),
    "Workday public primary work email"
  )
}

function employeeManagerWid(value: unknown): string {
  const reference = asObject(value, "Manager_Reference")
  const isEmployee = referenceHasIdType(reference, "Employee_ID")
  const isContingent = referenceHasIdType(reference, "Contingent_Worker_ID")
  const wid = referenceId(reference, "WID", "Manager_Reference")
  if (!isEmployee || isContingent || !wid) {
    throw new Error(
      "Workday returned an unclassifiable or non-employee manager reference."
    )
  }
  return wid
}

function managerWorkdayWids(
  workerData: JsonObject,
  organizationWid: string
): string[] {
  const managementChain = workerData.Management_Chain_Data
  const supervisoryChain = isObject(managementChain)
    ? managementChain.Worker_Supervisory_Management_Chain_Data
    : undefined
  if (!isObject(supervisoryChain)) {
    throw new Error(
      "Workday response is missing requested supervisory management-chain data."
    )
  }
  const chainEntries = asArray(supervisoryChain.Management_Chain_Data)
  if (chainEntries.length === 0) {
    throw new Error(
      "Workday response is missing requested supervisory management-chain data."
    )
  }
  const matchingChainEntries = chainEntries.filter((entry) => {
    if (!isObject(entry)) return false
    try {
      return (
        referenceWid(entry.Organization_Reference, "Organization_Reference") ===
        organizationWid
      )
    } catch {
      return false
    }
  })
  if (matchingChainEntries.length !== 1) {
    throw new Error(
      "Workday management chain does not match the supervisory organization."
    )
  }

  const currentOrganizationChain = asObject(
    matchingChainEntries[0],
    "Management_Chain_Data"
  )
  return [
    ...new Set(
      asArray(currentOrganizationChain.Manager_Reference).map(
        employeeManagerWid
      )
    ),
  ].sort()
}

function parseDirectoryPerson(
  value: unknown,
  projection: WorkdayDirectoryProjection
): DirectoryPerson {
  const worker = asObject(value, "Worker")
  const workerReference = worker.Worker_Reference
  const workdayWid = referenceWid(workerReference, "Worker_Reference")
  if (
    !referenceHasIdType(workerReference, "Employee_ID") ||
    referenceHasIdType(workerReference, "Contingent_Worker_ID")
  ) {
    throw new Error("Workday returned a non-employee worker reference.")
  }
  // The v46.1 schema defines Worker_Descriptor as the worker's Person Name.
  // Do not fall back to a generic reference Descriptor: tenants can format
  // those with identifiers, status, or other text outside this privacy contract.
  const name = valueText(worker.Worker_Descriptor)
  if (!name) throw new Error("Workday response is missing Worker_Descriptor.")

  const workerData = asObject(worker.Worker_Data, "Worker_Data")
  const organizationData = asObject(
    workerData.Organization_Data,
    "Organization_Data"
  )
  const memberships = asArray(organizationData.Worker_Organization_Data)
  if (memberships.length !== 1) {
    throw new Error(
      "Workday employee must have exactly one in-scope supervisory organization."
    )
  }

  const membership = asObject(memberships[0], "Worker_Organization_Data")
  const organizationReference = membership.Organization_Reference
  const currentOrganizationData = asObject(
    membership.Organization_Data,
    "Organization_Data"
  )
  const organizationWid = referenceWid(
    organizationReference,
    "Organization_Reference"
  )
  const organizationName = valueText(currentOrganizationData.Organization_Name)
  if (!organizationName) {
    throw new Error(
      "Workday response is missing supervisory organization name."
    )
  }

  return {
    workdayWid,
    name,
    supervisoryOrganization: {
      workdayWid: organizationWid,
      name: organizationName,
    },
    managerWorkdayWids:
      projection === "people"
        ? managerWorkdayWids(workerData, organizationWid)
        : [],
  }
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
})

function parseSoapBody(xml: string): JsonObject {
  if (XMLValidator.validate(xml) !== true) {
    throw new Error("Workday returned malformed XML.")
  }

  let parsed: unknown
  try {
    parsed = xmlParser.parse(xml) as unknown
  } catch {
    throw new Error("Workday returned malformed XML.")
  }

  const envelope = asObject(asObject(parsed, "Envelope").Envelope, "Envelope")
  const body = asObject(envelope.Body, "SOAP Body")
  if (body.Fault !== undefined) {
    throw new Error("Workday returned a SOAP fault.")
  }
  return body
}

export function parseGetWorkContactResponse(
  xml: string,
  requestedWorkdayWids: string[]
): Map<string, string | undefined> {
  if (
    requestedWorkdayWids.length === 0 ||
    requestedWorkdayWids.length > WORKDAY_PAGE_SIZE ||
    new Set(requestedWorkdayWids).size !== requestedWorkdayWids.length
  ) {
    throw new Error("Workday contact response has invalid requested workers.")
  }

  const body = parseSoapBody(xml)
  const response = asObject(
    body.Get_Change_Work_Contact_Information_Response,
    "Get_Change_Work_Contact_Information_Response"
  )
  const results = asObject(response.Response_Results, "Response_Results")
  const responseData = asObject(response.Response_Data, "Response_Data")
  const contacts = asArray(responseData.Change_Work_Contact_Information)
  const expected = requestedWorkdayWids.length
  if (
    responseInteger(results.Page, "Page") !== 1 ||
    responseInteger(results.Total_Pages, "Total_Pages") !== 1 ||
    responseInteger(results.Total_Results, "Total_Results") !== expected ||
    responseInteger(results.Page_Results, "Page_Results") !== expected ||
    contacts.length !== expected
  ) {
    throw new Error("Workday returned an incomplete work contact response.")
  }

  const requested = new Set(requestedWorkdayWids)
  const emails = new Map<string, string | undefined>()
  for (const value of contacts) {
    const contact = asObject(value, "Change_Work_Contact_Information")
    const workdayWid = referenceWid(
      contact.Person_Reference,
      "Person_Reference"
    )
    if (!requested.has(workdayWid) || emails.has(workdayWid)) {
      throw new Error(
        "Workday returned an unexpected or duplicate work contact person."
      )
    }

    const contactData = asArray(contact.Change_Work_Contact_Information_Data)
    if (contactData.length !== 1) {
      throw new Error("Workday response has invalid work contact data.")
    }
    const changeData = asObject(
      contactData[0],
      "Change_Work_Contact_Information_Data"
    )
    const personContact = asObject(
      changeData.Person_Contact_Information_Data,
      "Person_Contact_Information_Data"
    )
    const workEmail = publicPrimaryWorkEmail(
      personContact.Person_Email_Information_Data
    )
    emails.set(workdayWid, workEmail)
  }

  if (emails.size !== requested.size) {
    throw new Error("Workday returned an incomplete work contact response.")
  }
  return emails
}

export function parseGetWorkersResponse(
  xml: string,
  projection: WorkdayDirectoryProjection
): WorkdayWorkersPage {
  const body = parseSoapBody(xml)
  const response = asObject(body.Get_Workers_Response, "Get_Workers_Response")
  const results = asObject(response.Response_Results, "Response_Results")
  const responseData = asObject(response.Response_Data, "Response_Data")
  const workers = asArray(responseData.Worker)
  const people = workers.map((worker) =>
    parseDirectoryPerson(worker, projection)
  )

  const page = responseInteger(results.Page, "Page")
  const totalPages = responseInteger(results.Total_Pages, "Total_Pages")
  const totalResults = responseInteger(results.Total_Results, "Total_Results")
  const pageResults = responseInteger(results.Page_Results, "Page_Results")
  const expectedTotalPages = Math.ceil(totalResults / WORKDAY_PAGE_SIZE)
  const expectedPageResults =
    page < totalPages
      ? WORKDAY_PAGE_SIZE
      : totalResults - WORKDAY_PAGE_SIZE * (totalPages - 1)
  if (
    page < 1 ||
    totalPages < 1 ||
    totalResults < 1 ||
    page > totalPages ||
    totalPages !== expectedTotalPages ||
    pageResults !== people.length ||
    pageResults !== expectedPageResults ||
    people.length === 0
  ) {
    throw new Error("Workday returned an incomplete directory response.")
  }

  const seenPeople = new Set<string>()
  for (const person of people) {
    if (seenPeople.has(person.workdayWid)) {
      throw new Error("Workday returned a duplicate employee in one page.")
    }
    seenPeople.add(person.workdayWid)
  }

  return { page, totalPages, totalResults, people }
}

function isOverloadResponse(status: number, responseBody: string): boolean {
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return true
  }
  if (status !== 500) return false

  return /throttl|rate.?limit|server.?busy|system.?unavailable|too.?many.?concurrent/i.test(
    responseBody
  )
}

export function createWorkdayClient(
  config: WorkdayConfig,
  tokenProvider: WorkdayTokenProvider,
  beforeRequest: BeforeRequest,
  fetchImplementation: FetchImplementation = fetch
): WorkdayDirectoryClient {
  const fingerprintKeyVersion = createHmac("sha256", config.clientSecret)
    .update("notion-workday-directory:fingerprint-key-version", "utf8")
    .digest("base64url")
  const sourceContractFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        contractVersion: DIRECTORY_SYNC_CONTRACT_VERSION,
        apiUrl: config.apiUrl.replace(/\/+$/, ""),
        apiVersion: config.apiVersion,
        clientId: config.clientId,
        fingerprintKeyVersion,
        effectiveTimeZone: config.effectiveTimeZone,
        pageSize: WORKDAY_PAGE_SIZE,
      }),
      "utf8"
    )
    .digest("hex")

  async function postSoap(
    body: string,
    withoutClientTimeout: boolean
  ): Promise<string> {
    for (let authAttempt = 0; authAttempt < 2; authAttempt++) {
      const accessToken = await tokenProvider.getAccessToken()
      await beforeRequest()

      let response: Response
      try {
        response = await fetchImplementation(config.apiUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/xml, text/xml",
            "Content-Type": "text/xml; charset=utf-8",
            ...(config.externalApplicationId
              ? {
                  "wd-external-application-id": config.externalApplicationId,
                  // Workday recommends a unique ID for each HTTP attempt.
                  "wd-external-request-id": randomUUID(),
                }
              : {}),
          },
          body,
          redirect: "error",
          ...(withoutClientTimeout
            ? {}
            : { signal: AbortSignal.timeout(WORKDAY_REQUEST_TIMEOUT_MS) }),
        })
      } catch {
        throw new Error(
          "Workday SOAP request failed before receiving a response."
        )
      }

      const responseBody = await readBoundedResponseText(
        response,
        WORKDAY_SOAP_MAX_RESPONSE_BYTES,
        "Workday SOAP"
      )
      if (response.status === 401 && authAttempt === 0) {
        tokenProvider.invalidate(accessToken)
        continue
      }
      if (isOverloadResponse(response.status, responseBody)) {
        throw new RateLimitError({
          retryAfter: parseRetryAfterSeconds(
            response.headers.get("retry-after")
          ),
        })
      }
      if (!response.ok) {
        throw new Error(`Workday SOAP request failed (${response.status}).`)
      }
      return responseBody
    }

    throw new Error("Workday SOAP authentication failed after token renewal.")
  }

  function directoryFingerprint(
    domain: "work-email" | "worker",
    value: string
  ): string {
    return createHmac("sha256", config.clientSecret)
      .update(`notion-workday-directory:${domain}:${value}`, "utf8")
      .digest()
      .subarray(0, DIRECTORY_FINGERPRINT_BYTES)
      .toString("base64url")
  }

  return {
    effectiveTimeZone: config.effectiveTimeZone,
    sourceContractFingerprint,
    workerFingerprint(workdayWid) {
      const normalized = workdayWid.trim()
      if (!normalized) throw new Error("Workday employee WID is empty.")
      return directoryFingerprint("worker", normalized)
    },
    workEmailFingerprint(email) {
      const normalized = normalizedWorkEmail(
        email,
        "Workday public primary work email"
      )
      return directoryFingerprint("work-email", normalized)
    },
    async fetchWorkersPage(request, { projection }) {
      const workersResponse = await postSoap(
        buildGetWorkersRequest(config.apiVersion, request, projection),
        // Page 1 builds Workday's paging cache and can legitimately take
        // longer; Workday explicitly advises against a strict timeout.
        request.page === 1
      )
      const page = parseGetWorkersResponse(workersResponse, projection)
      if (projection === "organizations") return page

      const workdayWids = page.people.map((person) => person.workdayWid)
      const contactResponse = await postSoap(
        buildGetWorkContactRequest(config.apiVersion, request, workdayWids),
        false
      )
      const workEmails = parseGetWorkContactResponse(
        contactResponse,
        workdayWids
      )
      return {
        ...page,
        people: page.people.map((person) => {
          const workEmail = workEmails.get(person.workdayWid)
          return {
            ...person,
            ...(workEmail ? { workEmail } : {}),
          }
        }),
      }
    },
  }
}
