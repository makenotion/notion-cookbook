import {
  normalizeSalesforceOrigin,
  SALESFORCE_API_VERSION,
  type RuntimeConfig,
} from "./config.js"
import { isSalesforceId } from "./policy.js"
import type {
  OperationLedger,
  OpportunityRecord,
  SalesforceGateway,
  TransactionPlan,
  TransactionReceipt,
} from "./types.js"

const REQUEST_TIMEOUT_MS = 10_000
const MAX_OAUTH_RESPONSE_CHARS = 8_192
const MAX_API_RESPONSE_CHARS = 64 * 1024
const LEDGER_CHANGED_FIELDS = new Set(["CloseDate", "NextStep", "StageName"])

type FetchLike = typeof fetch
type Sleep = (milliseconds: number) => Promise<void>

type SalesforceSession = {
  accessToken: string
  instanceUrl: string
}

type SalesforceErrorBody = {
  error?: unknown
  errorCode?: unknown
}

type CompositeSubresponse = {
  body: unknown
  httpHeaders?: Record<string, unknown>
  httpStatusCode: number
  referenceId: string
}

export type SalesforceFailureKind =
  | "blocked"
  | "conflict"
  | "duplicate_claim"
  | "retryable"
  | "ambiguous"

export class SalesforceFailure extends Error {
  constructor(
    message: string,
    readonly kind: SalesforceFailureKind,
    readonly retryAfterSeconds: number | null = null
  ) {
    super(message)
    this.name = "SalesforceFailure"
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
  predicate: (value: string) => boolean
): string | null {
  const value = record[field]
  return typeof value === "string" && predicate(value) ? value : null
}

function nullableTaskId(
  record: Record<string, unknown>,
  field: string
): string | null | undefined {
  const value = record[field]
  if (value === null) return null
  return typeof value === "string" && isSalesforceId(value, "00T")
    ? value
    : undefined
}

/**
 * Validate every ledger field consumed by reconciliation before it can inform a
 * receipt or a follow-on write. Provider JSON is untrusted even after HTTP 200.
 */
export function parseOperationLedger(value: unknown): OperationLedger {
  const record = objectRecord(value)
  const id =
    record && requiredString(record, "Id", (item) => isSalesforceId(item))
  const operationKey =
    record &&
    requiredString(record, "OperationKey__c", (item) =>
      /^[a-f0-9]{64}$/.test(item)
    )
  const inputFingerprint =
    record &&
    requiredString(record, "InputFingerprint__c", (item) =>
      /^[a-f0-9]{64}$/.test(item)
    )
  const status = record?.Status__c
  const notionPageId =
    record &&
    requiredString(record, "NotionPageId__c", (item) =>
      /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(
        item
      )
    )
  const approvedRevision =
    record &&
    requiredString(
      record,
      "ApprovedRevision__c",
      (item) =>
        item.trim().length > 0 &&
        item.length <= 100 &&
        !/[\u0000-\u001f\u007f]/.test(item)
    )
  const opportunityId =
    record &&
    requiredString(record, "OpportunityId__c", (item) =>
      isSalesforceId(item, "006")
    )
  const activityId = record
    ? nullableTaskId(record, "ActivityId__c")
    : undefined
  const followUps = record
    ? ([1, 2, 3, 4, 5].map((index) =>
        nullableTaskId(record, `FollowUp${index}Id__c`)
      ) as Array<string | null | undefined>)
    : []
  const changedFieldsValue = record?.ChangedFields__c
  const changedFields =
    typeof changedFieldsValue === "string"
      ? changedFieldsValue.split(",").filter((item) => item.length > 0)
      : null
  const canonicalChangedFields =
    changedFields === null || changedFields.length === 0
      ? null
      : [...new Set(changedFields)].sort().join(",")
  const changedFieldsValid =
    changedFieldsValue === null ||
    (typeof changedFieldsValue === "string" &&
      changedFields !== null &&
      changedFieldsValue.length <= 255 &&
      changedFields.length === new Set(changedFields).size &&
      changedFields.every((field) => LEDGER_CHANGED_FIELDS.has(field)) &&
      changedFieldsValue === canonicalChangedFields)
  const followUpsHaveNoGaps = followUps.every(
    (item, index) =>
      item === null ||
      followUps.slice(0, index).every((prior) => prior !== null)
  )

  if (
    !record ||
    !id ||
    !operationKey ||
    !inputFingerprint ||
    !["Claimed", "SalesforceCommitted", "Completed"].includes(
      typeof status === "string" ? status : ""
    ) ||
    !notionPageId ||
    !approvedRevision ||
    !opportunityId ||
    activityId === undefined ||
    followUps.length !== 5 ||
    followUps.some((item) => item === undefined) ||
    !followUpsHaveNoGaps ||
    !changedFieldsValid ||
    (status !== "Claimed" && activityId === null)
  ) {
    throw new SalesforceFailure(
      "Salesforce ledger failed its runtime field contract.",
      "conflict"
    )
  }

  return {
    Id: id,
    OperationKey__c: operationKey,
    InputFingerprint__c: inputFingerprint,
    Status__c: status as OperationLedger["Status__c"],
    NotionPageId__c: notionPageId,
    ApprovedRevision__c: approvedRevision,
    OpportunityId__c: opportunityId,
    ActivityId__c: activityId,
    FollowUp1Id__c: followUps[0] as string | null,
    FollowUp2Id__c: followUps[1] as string | null,
    FollowUp3Id__c: followUps[2] as string | null,
    FollowUp4Id__c: followUps[3] as string | null,
    FollowUp5Id__c: followUps[4] as string | null,
    ChangedFields__c: canonicalChangedFields,
  }
}

function errorItems(value: unknown): SalesforceErrorBody[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is SalesforceErrorBody =>
        item != null && typeof item === "object"
    )
  }
  if (value != null && typeof value === "object") {
    const errors = (value as Record<string, unknown>).errors
    if (Array.isArray(errors)) return errorItems(errors)
    return [value as SalesforceErrorBody]
  }
  return []
}

const AGENT_SAFE_ERROR_CODES = new Set([
  "ALL_OR_NONE_OPERATION_ROLLED_BACK",
  "CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY",
  "CONFLICT",
  "DUPLICATE_EXTERNAL_ID",
  "DUPLICATES_DETECTED",
  "DUPLICATE_VALUE",
  "ENTITY_FAILED_IFLASTMODIFIED_ON_UPDATE",
  "FIELD_CUSTOM_VALIDATION_EXCEPTION",
  "INACTIVE_OWNER_OR_USER",
  "INSUFFICIENT_ACCESS",
  "INSUFFICIENT_ACCESS_OR_READONLY",
  "INVALID_CLIENT",
  "INVALID_CROSS_REFERENCE_KEY",
  "INVALID_FIELD",
  "INVALID_FIELD_FOR_INSERT_UPDATE",
  "INVALID_ID_FIELD",
  "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST",
  "INVALID_SESSION_ID",
  "MALFORMED_ID",
  "NOT_FOUND",
  "PRECONDITION_FAILED",
  "PROCESSING_HALTED",
  "REQUIRED_FIELD_MISSING",
  "REQUEST_LIMIT_EXCEEDED",
  "SERVER_UNAVAILABLE",
  "STRING_TOO_LONG",
])

function providerError(value: unknown): { code: string } {
  const item =
    errorItems(value).find((candidate) => {
      const code = candidate.errorCode
      return (
        code !== "PROCESSING_HALTED" &&
        code !== "ALL_OR_NONE_OPERATION_ROLLED_BACK"
      )
    }) ?? errorItems(value)[0]
  const rawCode = item?.errorCode ?? item?.error
  const normalized =
    typeof rawCode === "string" ? rawCode.trim().toUpperCase() : ""
  return {
    code: AGENT_SAFE_ERROR_CODES.has(normalized)
      ? normalized
      : "UNRECOGNIZED_ERROR",
  }
}

function retryAfterSeconds(response: Response): number | null {
  const value = response.headers.get("Retry-After")
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
  const at = Date.parse(value)
  if (Number.isNaN(at)) return null
  return Math.max(0, Math.ceil((at - Date.now()) / 1_000))
}

function recordUrl(
  instanceUrl: string,
  objectName: string,
  id: string
): string {
  return `${instanceUrl}/lightning/r/${objectName}/${id}/view`
}

export function salesforceRecordUrl(
  instanceUrl: string,
  objectName: "Opportunity" | "Task",
  id: string
): string {
  return recordUrl(instanceUrl, objectName, id)
}

function followUpIds(ledger: OperationLedger): string[] {
  return [
    ledger.FollowUp1Id__c,
    ledger.FollowUp2Id__c,
    ledger.FollowUp3Id__c,
    ledger.FollowUp4Id__c,
    ledger.FollowUp5Id__c,
  ].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  )
}

export function ledgerFollowUpIds(ledger: OperationLedger): string[] {
  return followUpIds(ledger)
}

function requestBodyDescription(summary: string, notionUrl: string): string {
  return `${summary}\n\nApproved Notion source: ${notionUrl}`
}

type CompositeRequest = {
  allOrNone: true
  compositeRequest: Array<{
    method: "POST" | "PATCH"
    url: string
    referenceId: string
    body: Record<string, unknown>
    httpHeaders?: Record<string, string>
  }>
}

export function buildCompositeRequest(
  plan: TransactionPlan,
  config: Pick<RuntimeConfig, "meetingTaskStatus" | "followUpTaskStatus">
): CompositeRequest {
  const apiRoot = `/services/data/${SALESFORCE_API_VERSION}`
  const requests: CompositeRequest["compositeRequest"] = [
    {
      method: "POST",
      url: `${apiRoot}/sobjects/Notion_Meeting_Operation__c`,
      referenceId: "operationClaim",
      body: {
        OperationKey__c: plan.operationKey,
        InputFingerprint__c: plan.inputFingerprint,
        Status__c: "Claimed",
        NotionPageId__c: plan.notionPageId,
        ApprovedRevision__c: plan.approvedRevision,
        OpportunityId__c: plan.opportunity.Id,
      },
    },
  ]

  if (Object.keys(plan.opportunityChanges).length > 0) {
    requests.push({
      method: "PATCH",
      url: `${apiRoot}/sobjects/Opportunity/${plan.opportunity.Id}`,
      referenceId: "opportunityUpdate",
      httpHeaders: {
        "If-Unmodified-Since": plan.opportunity.lastModifiedHeader,
      },
      body: plan.opportunityChanges,
    })
  }

  requests.push({
    method: "POST",
    url: `${apiRoot}/sobjects/Task`,
    referenceId: "meetingActivity",
    body: {
      Subject: plan.meeting.subject,
      Description: requestBodyDescription(
        plan.meeting.outcomeSummary,
        plan.notionUrl
      ),
      ActivityDate: plan.meeting.occurredOn,
      Status: config.meetingTaskStatus,
      WhatId: plan.opportunity.Id,
      OwnerId: plan.meeting.ownerId,
      ...(plan.meeting.primaryContactId
        ? { WhoId: plan.meeting.primaryContactId }
        : {}),
      Notion_Operation_Item_Key__c: `${plan.operationKey}:meeting`,
    },
  })

  plan.followUps.forEach((followUp, index) => {
    requests.push({
      method: "POST",
      url: `${apiRoot}/sobjects/Task`,
      referenceId: `followUp${index + 1}`,
      body: {
        Subject: followUp.subject,
        Description: followUp.description
          ? requestBodyDescription(followUp.description, plan.notionUrl)
          : `Approved Notion source: ${plan.notionUrl}`,
        ActivityDate: followUp.dueDate,
        Status: config.followUpTaskStatus,
        WhatId: plan.opportunity.Id,
        OwnerId: followUp.ownerId,
        ...(followUp.contactId ? { WhoId: followUp.contactId } : {}),
        Notion_Operation_Item_Key__c: `${plan.operationKey}:followup:${index + 1}`,
      },
    })
  })

  const ledgerUpdate: Record<string, unknown> = {
    Status__c: "SalesforceCommitted",
    ActivityId__c: "@{meetingActivity.id}",
    ChangedFields__c: Object.keys(plan.opportunityChanges).sort().join(","),
    SalesforceCommittedAt__c: plan.committedAt,
  }
  plan.followUps.forEach((_, index) => {
    ledgerUpdate[`FollowUp${index + 1}Id__c`] = `@{followUp${index + 1}.id}`
  })
  requests.push({
    method: "PATCH",
    url: `${apiRoot}/sobjects/Notion_Meeting_Operation__c/@{operationClaim.id}`,
    referenceId: "finalizeSalesforce",
    body: ledgerUpdate,
  })

  return { allOrNone: true, compositeRequest: requests }
}

function subresponseId(response: CompositeSubresponse | undefined): string {
  if (response?.body == null || typeof response.body !== "object") return ""
  const id = (response.body as Record<string, unknown>).id
  return typeof id === "string" ? id : ""
}

function exactCompositeResponses(
  value: unknown,
  expectedReferences: string[]
): CompositeSubresponse[] {
  const parsed = objectRecord(value)
  const rawResponses = parsed?.compositeResponse
  const expected = new Set(expectedReferences)
  if (!Array.isArray(rawResponses) || rawResponses.length !== expected.size) {
    throw new SalesforceFailure(
      "Salesforce returned an incomplete Composite receipt.",
      "ambiguous"
    )
  }

  const seen = new Set<string>()
  const responses: CompositeSubresponse[] = []
  for (const value of rawResponses) {
    const response = objectRecord(value)
    const referenceId = response?.referenceId
    const httpStatusCode = response?.httpStatusCode
    if (
      !response ||
      typeof referenceId !== "string" ||
      !expected.has(referenceId) ||
      seen.has(referenceId) ||
      typeof httpStatusCode !== "number" ||
      !Number.isInteger(httpStatusCode)
    ) {
      throw new SalesforceFailure(
        "Salesforce returned an inconsistent Composite receipt.",
        "ambiguous"
      )
    }
    seen.add(referenceId)
    responses.push({
      body: response.body,
      httpHeaders: objectRecord(response.httpHeaders) ?? undefined,
      httpStatusCode,
      referenceId,
    })
  }
  if (expectedReferences.some((reference) => !seen.has(reference))) {
    throw new SalesforceFailure(
      "Salesforce returned an incomplete Composite receipt.",
      "ambiguous"
    )
  }
  return responses
}

function classifyCompositeFailure(responses: CompositeSubresponse[]): never {
  const failed = responses.find(
    (response) =>
      response.httpStatusCode < 200 || response.httpStatusCode >= 300
  )
  const error = providerError(failed?.body)
  if (
    failed?.referenceId === "operationClaim" &&
    ["DUPLICATE_VALUE", "DUPLICATES_DETECTED"].includes(error.code)
  ) {
    throw new SalesforceFailure(
      "Another invocation already claimed this meeting outcome.",
      "duplicate_claim"
    )
  }
  if (
    failed?.httpStatusCode === 412 ||
    error.code === "ENTITY_FAILED_IFLASTMODIFIED_ON_UPDATE"
  ) {
    throw new SalesforceFailure(
      "The Opportunity changed during execution; no Salesforce writes committed.",
      "conflict"
    )
  }
  if (
    failed?.httpStatusCode === 429 ||
    error.code === "REQUEST_LIMIT_EXCEEDED"
  ) {
    throw new SalesforceFailure(
      "Salesforce rate-limited the transaction before completion.",
      "retryable"
    )
  }
  throw new SalesforceFailure(
    `Salesforce rejected the all-or-none transaction (${error.code}).`,
    "blocked"
  )
}

export function createSalesforceGateway(
  config: RuntimeConfig,
  options: {
    fetch?: FetchLike
    sleep?: Sleep
    requestTimeoutMs?: number
  } = {}
): SalesforceGateway {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const sleep = options.sleep ?? defaultSleep
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
  if (
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > REQUEST_TIMEOUT_MS
  ) {
    throw new Error(
      `Salesforce request timeout must be between 1 and ${REQUEST_TIMEOUT_MS} milliseconds.`
    )
  }
  let session: SalesforceSession | null = null
  let pendingSession: Promise<SalesforceSession> | null = null
  let currentInstanceUrl = config.salesforceOrgUrl

  async function timedFetchText(
    input: URL | string,
    init: RequestInit,
    ambiguousOnFailure: boolean,
    maximumResponseChars: number
  ): Promise<{ response: Response; text: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
    try {
      const response = await fetchImpl(input, {
        ...init,
        signal: controller.signal,
        redirect: "error",
      })
      // Keep the same abort budget active until the body has been consumed.
      // Receiving headers alone does not make a request bounded or a mutation
      // outcome observable.
      const text = (await response.text()).slice(0, maximumResponseChars)
      return { response, text }
    } catch {
      throw new SalesforceFailure(
        ambiguousOnFailure
          ? "Salesforce did not confirm whether the transaction committed."
          : "Salesforce could not be reached.",
        ambiguousOnFailure ? "ambiguous" : "retryable"
      )
    } finally {
      clearTimeout(timer)
    }
  }

  async function getSession(): Promise<SalesforceSession> {
    if (session) return session
    if (pendingSession) return pendingSession
    pendingSession = (async () => {
      const credentials = Buffer.from(
        `${config.salesforceClientId}:${config.salesforceClientSecret}`
      ).toString("base64")
      const { response, text } = await timedFetchText(
        new URL("/services/oauth2/token", `${config.salesforceOrgUrl}/`),
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${credentials}`,
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ grant_type: "client_credentials" }),
        },
        false,
        MAX_OAUTH_RESPONSE_CHARS
      )
      const body = parseJson(text)
      if (!response.ok || body == null || typeof body !== "object") {
        const error = providerError(body)
        throw new SalesforceFailure(
          `Salesforce OAuth rejected the client (${error.code}).`,
          "blocked"
        )
      }
      const token = (body as Record<string, unknown>).access_token
      const instanceUrl = (body as Record<string, unknown>).instance_url
      if (typeof token !== "string" || typeof instanceUrl !== "string") {
        throw new SalesforceFailure(
          "Salesforce OAuth returned an incomplete session.",
          "blocked"
        )
      }
      let normalized: string
      try {
        normalized = normalizeSalesforceOrigin(instanceUrl)
      } catch {
        throw new SalesforceFailure(
          "Salesforce OAuth returned an invalid instance URL.",
          "blocked"
        )
      }
      currentInstanceUrl = normalized
      session = { accessToken: token, instanceUrl: normalized }
      return session
    })().finally(() => {
      pendingSession = null
    })
    return pendingSession
  }

  async function apiRequest(
    path: string,
    init: RequestInit,
    optionsForRequest: {
      safeRead: boolean
      ambiguousOnFailure?: boolean
      allow404?: boolean
    }
  ): Promise<{ response: Response; text: string; json: unknown }> {
    // A 401 is an explicit authentication rejection, so Salesforce did not
    // execute the request. Refreshing the token and retrying once is safe even
    // for the Composite mutation. Other mutation failures are never retried.
    const maxAttempts = 2
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const active = await getSession()
      let response: Response
      let text: string
      try {
        const result = await timedFetchText(
          new URL(path, `${active.instanceUrl}/`),
          {
            ...init,
            headers: {
              Authorization: `Bearer ${active.accessToken}`,
              Accept: "application/json",
              ...(init.body !== undefined
                ? { "Content-Type": "application/json" }
                : {}),
              ...init.headers,
            },
          },
          optionsForRequest.ambiguousOnFailure === true,
          MAX_API_RESPONSE_CHARS
        )
        response = result.response
        text = result.text
      } catch (error) {
        if (
          optionsForRequest.safeRead &&
          attempt === 0 &&
          error instanceof SalesforceFailure &&
          error.kind === "retryable"
        ) {
          await sleep(100)
          continue
        }
        throw error
      }
      const json = parseJson(text)

      if (response.status === 401 && attempt === 0) {
        session = null
        continue
      }
      if (response.status === 404 && optionsForRequest.allow404) {
        return { response, text, json }
      }
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = retryAfterSeconds(response)
        if (
          optionsForRequest.safeRead &&
          attempt === 0 &&
          (retryAfter === null || retryAfter <= 2)
        ) {
          await sleep((retryAfter ?? 0.1) * 1_000)
          continue
        }
        throw new SalesforceFailure(
          response.status === 429
            ? "Salesforce rate-limited the request."
            : "Salesforce is temporarily unavailable.",
          response.status === 429
            ? "retryable"
            : optionsForRequest.ambiguousOnFailure
              ? "ambiguous"
              : "retryable",
          retryAfter
        )
      }
      if ([409, 412].includes(response.status)) {
        const error = providerError(json)
        throw new SalesforceFailure(
          `Salesforce rejected the record precondition (${error.code}).`,
          "conflict"
        )
      }
      if (!response.ok) {
        const error = providerError(json)
        throw new SalesforceFailure(
          `Salesforce API rejected the request (${error.code}).`,
          "blocked"
        )
      }
      return { response, text, json }
    }
    throw new SalesforceFailure(
      "Salesforce request retry exhausted.",
      "retryable"
    )
  }

  async function query<T>(soql: string): Promise<T[]> {
    const url = new URL(
      `/services/data/${SALESFORCE_API_VERSION}/query/`,
      config.salesforceOrgUrl
    )
    url.searchParams.set("q", soql)
    const result = await apiRequest(
      `${url.pathname}${url.search}`,
      { method: "GET" },
      { safeRead: true }
    )
    if (result.json == null || typeof result.json !== "object") {
      throw new SalesforceFailure(
        "Salesforce query returned invalid JSON.",
        "retryable"
      )
    }
    const records = (result.json as Record<string, unknown>).records
    if (!Array.isArray(records)) {
      throw new SalesforceFailure(
        "Salesforce query returned no records array.",
        "retryable"
      )
    }
    return records as T[]
  }

  return {
    get instanceUrl() {
      return currentInstanceUrl
    },
    async getLedger(operationKey) {
      const fields = [
        "Id",
        "OperationKey__c",
        "InputFingerprint__c",
        "Status__c",
        "NotionPageId__c",
        "ApprovedRevision__c",
        "OpportunityId__c",
        "ActivityId__c",
        "FollowUp1Id__c",
        "FollowUp2Id__c",
        "FollowUp3Id__c",
        "FollowUp4Id__c",
        "FollowUp5Id__c",
        "ChangedFields__c",
      ].join(",")
      const result = await apiRequest(
        `/services/data/${SALESFORCE_API_VERSION}/sobjects/Notion_Meeting_Operation__c/OperationKey__c/${operationKey}?fields=${encodeURIComponent(fields)}`,
        { method: "GET" },
        { safeRead: true, allow404: true }
      )
      if (result.response.status === 404) return null
      if (result.json == null || typeof result.json !== "object") {
        throw new SalesforceFailure(
          "Salesforce ledger returned invalid JSON.",
          "retryable"
        )
      }
      return parseOperationLedger(result.json)
    },
    async getOpportunity(opportunityId) {
      const fields = [
        "Id",
        "OwnerId",
        "StageName",
        "CloseDate",
        "NextStep",
        "LastModifiedDate",
      ].join(",")
      const result = await apiRequest(
        `/services/data/${SALESFORCE_API_VERSION}/sobjects/Opportunity/${opportunityId}?fields=${encodeURIComponent(fields)}`,
        { method: "GET" },
        { safeRead: true }
      )
      if (result.json == null || typeof result.json !== "object") {
        throw new SalesforceFailure(
          "Salesforce Opportunity returned invalid JSON.",
          "retryable"
        )
      }
      const opportunity = result.json as Omit<
        OpportunityRecord,
        "lastModifiedHeader"
      >
      const lastModifiedHeader = result.response.headers.get("Last-Modified")
      if (!lastModifiedHeader) {
        throw new SalesforceFailure(
          "Salesforce did not return the Last-Modified precondition header.",
          "blocked"
        )
      }
      return { ...opportunity, lastModifiedHeader }
    },
    async getOpportunityContactIds(opportunityId, contactIds) {
      if (contactIds.length === 0) return new Set()
      const ids = [...new Set(contactIds)].map((id) => `'${id}'`).join(",")
      const records = await query<{ ContactId?: unknown }>(
        `SELECT ContactId FROM OpportunityContactRole WHERE OpportunityId = '${opportunityId}' AND ContactId IN (${ids}) LIMIT ${contactIds.length}`
      )
      return new Set(
        records
          .map((record) => record.ContactId)
          .filter((value): value is string => typeof value === "string")
      )
    },
    async getActiveUserIds(userIds) {
      if (userIds.length === 0) return new Set()
      const ids = [...new Set(userIds)].map((id) => `'${id}'`).join(",")
      const records = await query<{ Id?: unknown; IsActive?: unknown }>(
        `SELECT Id, IsActive FROM User WHERE Id IN (${ids}) LIMIT ${userIds.length}`
      )
      return new Set(
        records
          .filter((record) => record.IsActive === true)
          .map((record) => record.Id)
          .filter((value): value is string => typeof value === "string")
      )
    },
    async getTasksByOperationKeys(keys) {
      if (keys.length === 0) return new Map()
      const uniqueKeys = [...new Set(keys)]
      if (
        keys.length > 6 ||
        uniqueKeys.length !== keys.length ||
        uniqueKeys.some(
          (key) => !/^[a-f0-9]{64}:(?:meeting|followup:[1-5])$/.test(key)
        )
      ) {
        throw new SalesforceFailure(
          "Task operation-key lookup violated its bounded contract.",
          "blocked"
        )
      }
      const values = uniqueKeys.map((key) => `'${key}'`).join(",")
      const records = await query<{
        Id?: unknown
        Notion_Operation_Item_Key__c?: unknown
      }>(
        `SELECT Id, Notion_Operation_Item_Key__c FROM Task WHERE Notion_Operation_Item_Key__c IN (${values}) LIMIT ${keys.length}`
      )
      const allowedKeys = new Set(uniqueKeys)
      const result = new Map<string, string>()
      for (const record of records) {
        const id = record.Id
        const key = record.Notion_Operation_Item_Key__c
        if (
          typeof id !== "string" ||
          !isSalesforceId(id, "00T") ||
          typeof key !== "string" ||
          !allowedKeys.has(key) ||
          result.has(key)
        ) {
          throw new SalesforceFailure(
            "Salesforce Task evidence failed its runtime field contract.",
            "conflict"
          )
        }
        result.set(key, id)
      }
      return result
    },
    async executeTransaction(plan) {
      const request = buildCompositeRequest(plan, config)
      let result: Awaited<ReturnType<typeof apiRequest>>
      try {
        result = await apiRequest(
          `/services/data/${SALESFORCE_API_VERSION}/composite`,
          { method: "POST", body: JSON.stringify(request) },
          { safeRead: false, ambiguousOnFailure: true }
        )
      } catch (error) {
        if (error instanceof SalesforceFailure) throw error
        throw new SalesforceFailure(
          "Salesforce did not confirm whether the transaction committed.",
          "ambiguous"
        )
      }
      const expectedReferences = request.compositeRequest.map(
        ({ referenceId }) => referenceId
      )
      const responses = exactCompositeResponses(result.json, expectedReferences)
      if (
        responses.some(
          (response) =>
            response.httpStatusCode < 200 || response.httpStatusCode >= 300
        )
      ) {
        classifyCompositeFailure(responses)
      }

      const byReference = new Map(
        responses.map((response) => [response.referenceId, response])
      )
      const ledgerId = subresponseId(byReference.get("operationClaim"))
      const activityId = subresponseId(byReference.get("meetingActivity"))
      const createdFollowUps = plan.followUps.map((_, index) =>
        subresponseId(byReference.get(`followUp${index + 1}`))
      )
      const taskIds = [activityId, ...createdFollowUps]
      if (
        !isSalesforceId(ledgerId) ||
        taskIds.some((id) => !isSalesforceId(id, "00T")) ||
        new Set(taskIds).size !== taskIds.length
      ) {
        throw new SalesforceFailure(
          "Salesforce committed but omitted canonical record IDs.",
          "ambiguous"
        )
      }
      const ledger: OperationLedger = {
        Id: ledgerId,
        OperationKey__c: plan.operationKey,
        InputFingerprint__c: plan.inputFingerprint,
        Status__c: "SalesforceCommitted",
        NotionPageId__c: plan.notionPageId,
        ApprovedRevision__c: plan.approvedRevision,
        OpportunityId__c: plan.opportunity.Id,
        ActivityId__c: activityId,
        FollowUp1Id__c: createdFollowUps[0] ?? null,
        FollowUp2Id__c: createdFollowUps[1] ?? null,
        FollowUp3Id__c: createdFollowUps[2] ?? null,
        FollowUp4Id__c: createdFollowUps[3] ?? null,
        FollowUp5Id__c: createdFollowUps[4] ?? null,
        ChangedFields__c:
          Object.keys(plan.opportunityChanges).sort().join(",") || null,
      }
      return {
        ledger,
        opportunityChanged: Object.keys(plan.opportunityChanges).length > 0,
        activityId,
        followUpIds: createdFollowUps,
      }
    },
    async markCompleted(ledgerId, notionReceiptHash) {
      await apiRequest(
        `/services/data/${SALESFORCE_API_VERSION}/sobjects/Notion_Meeting_Operation__c/${ledgerId}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            Status__c: "Completed",
            NotionReceiptHash__c: notionReceiptHash,
          }),
        },
        { safeRead: false, ambiguousOnFailure: false }
      )
    },
  }
}
