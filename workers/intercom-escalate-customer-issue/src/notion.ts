const PROPERTY_NAMES = {
  sourceKey: "Intercom source key",
  priority: "Priority",
  customer: "Customer",
  company: "Company",
  intercomUpdated: "Intercom updated",
  conversationId: "Conversation ID",
} as const

const PRIORITIES = ["P0", "P1", "P2", "P3"] as const
const NOTION_ID = /^[0-9a-f]{32}$/i
const INTERCOM_ID = /^[A-Za-z0-9_-]{1,100}$/
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
const MAX_PROPERTY_ID_LENGTH = 100
const MAX_SOURCE_KEY_LENGTH = 300
const MAX_TITLE_LENGTH = 200
const MAX_PERSON_LENGTH = 200
const MAX_SUMMARY_LENGTH = 2_000
const MAX_IMPACT_LENGTH = 4_000
const MAX_ENVIRONMENT_LENGTH = 2_000
const MAX_REPRODUCTION_STEPS = 12
const MAX_REPRODUCTION_STEP_LENGTH = 1_000
const MAX_EVIDENCE_ITEMS = 12
const MAX_EVIDENCE_ITEM_LENGTH = 2_000
const MAX_RICH_TEXT_FRAGMENT_LENGTH = 2_000
const MAX_INTERCOM_URL_LENGTH = 2_000
const MAX_QUERY_RESULTS = 2

export type TicketPriority = (typeof PRIORITIES)[number]
export type NotionCreateDisposition = "definite_rejection" | "outcome_unknown"

export interface NotionClientLike {
  dataSources: {
    retrieve(args: { data_source_id: string }): Promise<unknown>
    query(args: {
      data_source_id: string
      filter: {
        property: string
        rich_text: { equals: string }
      }
      page_size: 2
      result_type: "page"
    }): Promise<unknown>
  }
  pages: {
    retrieve(args: { page_id: string }): Promise<unknown>
    create(args: {
      parent: { type: "data_source_id"; data_source_id: string }
      properties: Record<string, unknown>
      children: unknown[]
    }): Promise<unknown>
  }
}

export interface TicketPropertyReference {
  id: string
  name: string
}

export interface TicketDataSourceSchema {
  dataSourceId: string
  title: TicketPropertyReference
  sourceKey: TicketPropertyReference
  priority: TicketPropertyReference
  customer: TicketPropertyReference
  company: TicketPropertyReference
  intercomUpdated: TicketPropertyReference
  priorityOptionIds: Record<TicketPriority, string>
}

export interface SyncedConversationReference {
  pageId: string
  conversationId: string
  pageUrl: string
}

export interface TicketPageReference {
  pageId: string
  pageUrl: string
  sourceKey: string
}

export interface TicketBody {
  summary: string
  impact: string
  environment: string | null
  reproductionSteps: string[]
  evidence: string[]
  intercomUrl: string
}

export interface CreateTicketPageInput {
  schema: TicketDataSourceSchema
  sourceKey: string
  title: string
  priority: TicketPriority
  customer: string | null
  company: string | null
  intercomUpdatedAt: string
  body: TicketBody
}

export class NotionAdapterError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false
  ) {
    super(message)
    this.name = "NotionAdapterError"
  }
}

export class NotionCreateError extends NotionAdapterError {
  constructor(
    public readonly disposition: NotionCreateDisposition,
    retryable = disposition === "outcome_unknown",
    public readonly pageId: string | null = null
  ) {
    super(
      disposition === "definite_rejection"
        ? "NOTION_CREATE_REJECTED"
        : "NOTION_CREATE_OUTCOME_UNKNOWN",
      disposition === "definite_rejection"
        ? "Notion rejected the ticket create request."
        : "Notion did not confirm whether the ticket was created.",
      retryable
    )
    this.name = "NotionCreateError"
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NotionAdapterError(
      "NOTION_RESPONSE_INVALID",
      `Notion returned an invalid ${label}.`
    )
  }
  return value as Record<string, unknown>
}

function normalizeNotionId(value: string, label: string): string {
  const normalized = value.replace(/-/g, "").toLowerCase()
  if (!NOTION_ID.test(normalized)) {
    throw new NotionAdapterError(
      "NOTION_ID_INVALID",
      `${label} must be a Notion ID.`
    )
  }
  return normalized
}

function notionPageId(value: string): string {
  const trimmed = value.trim()
  if (NOTION_ID.test(trimmed.replace(/-/g, ""))) {
    return normalizeNotionId(trimmed, "Notion conversation page ID")
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new NotionAdapterError(
      "NOTION_ID_INVALID",
      "The synced Conversation reference must be a Notion page ID or URL."
    )
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !(url.hostname === "notion.so" || url.hostname.endsWith(".notion.so"))
  ) {
    throw new NotionAdapterError(
      "NOTION_ID_INVALID",
      "The synced Conversation reference must be a Notion page ID or URL."
    )
  }
  const matches = url.pathname.match(
    /[0-9a-f]{8}(?:-?[0-9a-f]{4}){3}-?[0-9a-f]{12}/gi
  )
  if (!matches || matches.length !== 1) {
    throw new NotionAdapterError(
      "NOTION_ID_INVALID",
      "The synced Conversation URL must contain exactly one Notion page ID."
    )
  }
  return normalizeNotionId(matches[0], "Notion conversation page ID")
}

function sameNotionId(left: string, right: string): boolean {
  return (
    left.replace(/-/g, "").toLowerCase() ===
    right.replace(/-/g, "").toLowerCase()
  )
}

function boundedPlainText(
  value: string,
  label: string,
  maximum: number,
  allowEmpty = false
): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim()
  if (
    (!allowEmpty && normalized.length === 0) ||
    normalized.length > maximum ||
    CONTROL_CHARACTER.test(normalized.replace(/\n/g, ""))
  ) {
    throw new NotionAdapterError(
      "NOTION_INPUT_INVALID",
      `${label} must be bounded plain text.`
    )
  }
  return normalized
}

function propertyId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_PROPERTY_ID_LENGTH ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new NotionAdapterError(
      "NOTION_SCHEMA_INVALID",
      `The ${label} property has an invalid ID.`
    )
  }
  return value
}

function activeFullPage(
  value: unknown,
  expectedPageId?: string
): Record<string, unknown> {
  const page = record(value, "page")
  if (
    page.object !== "page" ||
    typeof page.id !== "string" ||
    (expectedPageId !== undefined && !sameNotionId(page.id, expectedPageId)) ||
    page.in_trash !== false ||
    page.is_archived !== false ||
    page.archived === true ||
    typeof page.url !== "string" ||
    !isNotionPageUrl(page.url) ||
    typeof page.last_edited_time !== "string" ||
    !validIsoDate(page.last_edited_time) ||
    !page.properties ||
    typeof page.properties !== "object" ||
    Array.isArray(page.properties)
  ) {
    throw new NotionAdapterError(
      "NOTION_PAGE_INVALID",
      "The Notion page is missing, inactive, partial, or malformed."
    )
  }
  return page
}

function dataSourceParentId(page: Record<string, unknown>): string {
  const parent = record(page.parent, "page parent")
  if (
    parent.type !== "data_source_id" ||
    typeof parent.data_source_id !== "string"
  ) {
    throw new NotionAdapterError(
      "NOTION_PAGE_PARENT_INVALID",
      "The Notion page does not belong to a data source."
    )
  }
  normalizeNotionId(parent.data_source_id, "Notion data source ID")
  return parent.data_source_id
}

function richTextValue(
  properties: Record<string, unknown>,
  propertyNameOrId: string,
  label: string,
  maximum: number
): string {
  const property = record(properties[propertyNameOrId], `${label} property`)
  if (property.type !== "rich_text" || !Array.isArray(property.rich_text)) {
    throw new NotionAdapterError(
      "NOTION_PAGE_PROPERTY_INVALID",
      `The Notion ${label} property must be rich text.`
    )
  }
  if (property.rich_text.length > 12) {
    throw new NotionAdapterError(
      "NOTION_PAGE_PROPERTY_INVALID",
      `The Notion ${label} property is not bounded.`
    )
  }
  let result = ""
  for (const fragmentValue of property.rich_text) {
    const fragment = record(fragmentValue, `${label} rich-text fragment`)
    if (typeof fragment.plain_text !== "string") {
      throw new NotionAdapterError(
        "NOTION_PAGE_PROPERTY_INVALID",
        `The Notion ${label} property contains invalid text.`
      )
    }
    result += fragment.plain_text
    if (result.length > maximum) {
      throw new NotionAdapterError(
        "NOTION_PAGE_PROPERTY_INVALID",
        `The Notion ${label} property is too long.`
      )
    }
  }
  return boundedPlainText(result, `Notion ${label}`, maximum)
}

function validIsoDate(value: string): boolean {
  if (value.length > 40) return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
}

function normalizedIsoDate(value: string, label: string): string {
  const normalized = boundedPlainText(value, label, 100)
  if (!validIsoDate(normalized)) {
    throw new NotionAdapterError(
      "NOTION_INPUT_INVALID",
      `${label} must be an ISO date.`
    )
  }
  return new Date(normalized).toISOString()
}

function isHttpsUrl(value: string): boolean {
  if (value.length > MAX_INTERCOM_URL_LENGTH) return false
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password
  } catch {
    return false
  }
}

function isNotionPageUrl(value: string): boolean {
  if (!isHttpsUrl(value)) return false
  const url = new URL(value)
  return url.hostname === "notion.so" || url.hostname.endsWith(".notion.so")
}

function httpsUrl(value: string, label: string): string {
  if (!isHttpsUrl(value)) {
    throw new NotionAdapterError(
      "NOTION_INPUT_INVALID",
      `${label} must be a bounded HTTPS URL without credentials.`
    )
  }
  return value
}

async function readCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof NotionAdapterError) throw error
    const status = httpStatus(error)
    const retryable =
      status === null ||
      status === 408 ||
      status === 409 ||
      status === 429 ||
      status >= 500
    throw new NotionAdapterError(
      "NOTION_UNAVAILABLE",
      "Notion did not complete the read request.",
      retryable
    )
  }
}

function requiredProperty(
  properties: Record<string, unknown>,
  name: string,
  expectedType: string
): TicketPropertyReference & { raw: Record<string, unknown> } {
  const property = record(properties[name], `${name} data-source property`)
  if (property.type !== expectedType || property.name !== name) {
    throw new NotionAdapterError(
      "NOTION_SCHEMA_INVALID",
      `The Notion ticket data source requires ${name} as ${expectedType}.`
    )
  }
  return {
    id: propertyId(property.id, name),
    name,
    raw: property,
  }
}

export async function retrieveTicketDataSourceSchema(
  notion: NotionClientLike,
  dataSourceId: string
): Promise<TicketDataSourceSchema> {
  normalizeNotionId(dataSourceId, "Notion ticket data source ID")
  const raw = record(
    await readCall(() =>
      notion.dataSources.retrieve({ data_source_id: dataSourceId })
    ),
    "ticket data source"
  )
  if (
    raw.object !== "data_source" ||
    typeof raw.id !== "string" ||
    !sameNotionId(raw.id, dataSourceId) ||
    raw.in_trash !== false ||
    raw.archived !== false ||
    !raw.properties ||
    typeof raw.properties !== "object" ||
    Array.isArray(raw.properties)
  ) {
    throw new NotionAdapterError(
      "NOTION_SCHEMA_INVALID",
      "The Notion ticket data source is missing, inactive, partial, or malformed."
    )
  }

  const properties = raw.properties as Record<string, unknown>
  const titleProperties = Object.entries(properties).filter(([, value]) => {
    return Boolean(
      value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).type === "title"
    )
  })
  if (titleProperties.length !== 1) {
    throw new NotionAdapterError(
      "NOTION_SCHEMA_INVALID",
      "The Notion ticket data source must have exactly one title property."
    )
  }
  const [titleName, titleValue] = titleProperties[0]
  const titleRaw = record(titleValue, "title data-source property")
  if (titleRaw.name !== titleName) {
    throw new NotionAdapterError(
      "NOTION_SCHEMA_INVALID",
      "The Notion ticket title property is malformed."
    )
  }
  const title = { id: propertyId(titleRaw.id, "title"), name: titleName }
  const sourceKey = requiredProperty(
    properties,
    PROPERTY_NAMES.sourceKey,
    "rich_text"
  )
  const priority = requiredProperty(
    properties,
    PROPERTY_NAMES.priority,
    "select"
  )
  const customer = requiredProperty(
    properties,
    PROPERTY_NAMES.customer,
    "rich_text"
  )
  const company = requiredProperty(
    properties,
    PROPERTY_NAMES.company,
    "rich_text"
  )
  const intercomUpdated = requiredProperty(
    properties,
    PROPERTY_NAMES.intercomUpdated,
    "date"
  )

  const select = record(priority.raw.select, "Priority select configuration")
  if (!Array.isArray(select.options) || select.options.length > 100) {
    throw new NotionAdapterError(
      "NOTION_SCHEMA_INVALID",
      "Priority must include the P0, P1, P2, and P3 options."
    )
  }
  const priorityOptionIds = {} as Record<TicketPriority, string>
  const seenNames = new Set<string>()
  const seenIds = new Set<string>()
  for (const optionValue of select.options) {
    const option = record(optionValue, "Priority option")
    if (
      typeof option.name !== "string" ||
      !PRIORITIES.includes(option.name as TicketPriority)
    )
      continue
    const id = propertyId(option.id, `Priority ${option.name} option`)
    if (seenNames.has(option.name) || seenIds.has(id)) {
      throw new NotionAdapterError(
        "NOTION_SCHEMA_INVALID",
        "The required Priority option names and IDs must be unique."
      )
    }
    seenNames.add(option.name)
    seenIds.add(id)
    priorityOptionIds[option.name as TicketPriority] = id
  }
  if (!PRIORITIES.every((priorityName) => seenNames.has(priorityName))) {
    throw new NotionAdapterError(
      "NOTION_SCHEMA_INVALID",
      "Priority must include the P0, P1, P2, and P3 options."
    )
  }

  const requiredIds = [
    title.id,
    sourceKey.id,
    priority.id,
    customer.id,
    company.id,
    intercomUpdated.id,
  ]
  if (new Set(requiredIds).size !== requiredIds.length) {
    throw new NotionAdapterError(
      "NOTION_SCHEMA_INVALID",
      "The required Notion ticket properties must have unique IDs."
    )
  }

  return {
    dataSourceId: raw.id,
    title,
    sourceKey: { id: sourceKey.id, name: sourceKey.name },
    priority: { id: priority.id, name: priority.name },
    customer: { id: customer.id, name: customer.name },
    company: { id: company.id, name: company.name },
    intercomUpdated: {
      id: intercomUpdated.id,
      name: intercomUpdated.name,
    },
    priorityOptionIds,
  }
}

export async function resolveSyncedConversationPage(
  notion: NotionClientLike,
  pageId: string
): Promise<SyncedConversationReference> {
  const normalizedPageId = notionPageId(pageId)
  const page = activeFullPage(
    await readCall(() => notion.pages.retrieve({ page_id: normalizedPageId })),
    normalizedPageId
  )
  const properties = page.properties as Record<string, unknown>
  dataSourceParentId(page)
  const conversationId = richTextValue(
    properties,
    PROPERTY_NAMES.conversationId,
    PROPERTY_NAMES.conversationId,
    100
  )
  if (!INTERCOM_ID.test(conversationId)) {
    throw new NotionAdapterError(
      "NOTION_PAGE_PROPERTY_INVALID",
      "The synced Conversation ID is malformed."
    )
  }
  return {
    pageId: page.id as string,
    conversationId,
    pageUrl: page.url as string,
  }
}

function parseVerifiedTicketPage(
  value: unknown,
  schema: TicketDataSourceSchema,
  expectedSourceKey: string,
  expectedPageId?: string
): TicketPageReference {
  const page = activeFullPage(value, expectedPageId)
  const parentId = dataSourceParentId(page)
  if (!sameNotionId(parentId, schema.dataSourceId)) {
    throw new NotionAdapterError(
      "NOTION_TICKET_MISMATCH",
      "The mapped Notion ticket belongs to a different data source."
    )
  }
  const sourceKey = richTextValue(
    page.properties as Record<string, unknown>,
    schema.sourceKey.name,
    PROPERTY_NAMES.sourceKey,
    MAX_SOURCE_KEY_LENGTH
  )
  if (sourceKey !== expectedSourceKey) {
    throw new NotionAdapterError(
      "NOTION_TICKET_MISMATCH",
      "The mapped Notion ticket belongs to a different Intercom source."
    )
  }
  return {
    pageId: page.id as string,
    pageUrl: page.url as string,
    sourceKey,
  }
}

export async function queryTicketsBySourceKey(
  notion: NotionClientLike,
  schema: TicketDataSourceSchema,
  sourceKeyValue: string
): Promise<TicketPageReference[]> {
  normalizeNotionId(schema.dataSourceId, "Notion ticket data source ID")
  propertyId(schema.sourceKey.id, PROPERTY_NAMES.sourceKey)
  const sourceKey = boundedPlainText(
    sourceKeyValue,
    PROPERTY_NAMES.sourceKey,
    MAX_SOURCE_KEY_LENGTH
  )
  const response = record(
    await readCall(() =>
      notion.dataSources.query({
        data_source_id: schema.dataSourceId,
        filter: {
          property: schema.sourceKey.id,
          rich_text: { equals: sourceKey },
        },
        page_size: MAX_QUERY_RESULTS,
        result_type: "page",
      })
    ),
    "ticket query"
  )
  if (
    response.object !== "list" ||
    !Array.isArray(response.results) ||
    response.results.length > MAX_QUERY_RESULTS ||
    typeof response.has_more !== "boolean" ||
    (response.next_cursor !== null && typeof response.next_cursor !== "string")
  ) {
    throw new NotionAdapterError(
      "NOTION_QUERY_INVALID",
      "Notion returned an invalid ticket query result."
    )
  }
  if (
    response.request_status !== undefined &&
    record(response.request_status, "ticket query status").type !== "complete"
  ) {
    throw new NotionAdapterError(
      "NOTION_QUERY_INCOMPLETE",
      "Notion did not complete the ticket lookup.",
      true
    )
  }
  if (response.has_more || response.next_cursor !== null) {
    throw new NotionAdapterError(
      "NOTION_QUERY_NOT_UNIQUE",
      "Notion returned more source-key matches than the bounded uniqueness check can accept."
    )
  }
  return response.results.map((page) =>
    parseVerifiedTicketPage(page, schema, sourceKey)
  )
}

function richTextRequest(value: string | null): Array<{
  type: "text"
  text: { content: string }
}> {
  if (value === null || value.length === 0) return []
  const chunks: Array<{ type: "text"; text: { content: string } }> = []
  for (
    let offset = 0;
    offset < value.length;
    offset += MAX_RICH_TEXT_FRAGMENT_LENGTH
  ) {
    chunks.push({
      type: "text",
      text: {
        content: value.slice(offset, offset + MAX_RICH_TEXT_FRAGMENT_LENGTH),
      },
    })
  }
  return chunks
}

function heading(content: string): Record<string, unknown> {
  return {
    object: "block",
    type: "heading_2",
    heading_2: { rich_text: richTextRequest(content) },
  }
}

function paragraph(content: string): Record<string, unknown> {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: richTextRequest(content) },
  }
}

function numberedItem(content: string): Record<string, unknown> {
  return {
    object: "block",
    type: "numbered_list_item",
    numbered_list_item: { rich_text: richTextRequest(content) },
  }
}

function quote(content: string): Record<string, unknown> {
  return {
    object: "block",
    type: "quote",
    quote: { rich_text: richTextRequest(content) },
  }
}

function linkParagraph(url: string): Record<string, unknown> {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [
        {
          type: "text",
          text: {
            content: "Open the source conversation in Intercom",
            link: { url },
          },
        },
      ],
    },
  }
}

function ticketBlocks(body: TicketBody): Record<string, unknown>[] {
  const summary = boundedPlainText(body.summary, "Summary", MAX_SUMMARY_LENGTH)
  const impact = boundedPlainText(
    body.impact,
    "Customer impact",
    MAX_IMPACT_LENGTH
  )
  const environment =
    body.environment === null
      ? null
      : boundedPlainText(
          body.environment,
          "Environment",
          MAX_ENVIRONMENT_LENGTH
        )
  if (
    !Array.isArray(body.reproductionSteps) ||
    body.reproductionSteps.length > MAX_REPRODUCTION_STEPS ||
    !Array.isArray(body.evidence) ||
    body.evidence.length > MAX_EVIDENCE_ITEMS
  ) {
    throw new NotionAdapterError(
      "NOTION_INPUT_INVALID",
      "Ticket evidence and reproduction steps must be bounded lists."
    )
  }
  const reproductionSteps = body.reproductionSteps.map((step) =>
    boundedPlainText(step, "Reproduction step", MAX_REPRODUCTION_STEP_LENGTH)
  )
  const evidence = body.evidence.map((item) =>
    boundedPlainText(item, "Customer evidence", MAX_EVIDENCE_ITEM_LENGTH)
  )
  const intercomUrl = httpsUrl(body.intercomUrl, "Intercom URL")

  const blocks: Record<string, unknown>[] = [
    heading("Summary"),
    paragraph(summary),
    heading("Customer impact"),
    paragraph(impact),
  ]
  if (environment !== null) {
    blocks.push(heading("Environment"), paragraph(environment))
  }
  if (reproductionSteps.length > 0) {
    blocks.push(
      heading("Reproduction steps"),
      ...reproductionSteps.map(numberedItem)
    )
  }
  if (evidence.length > 0) {
    blocks.push(heading("Customer evidence"), ...evidence.map(quote))
  }
  blocks.push(heading("Source"), linkParagraph(intercomUrl))
  return blocks
}

function httpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || Array.isArray(error)) return null
  const status = (error as Record<string, unknown>).status
  return typeof status === "number" && Number.isInteger(status) ? status : null
}

function classifyCreateError(error: unknown): {
  disposition: NotionCreateDisposition
  retryable: boolean
} {
  const status = httpStatus(error)
  if (status === 409 || status === 429) {
    return { disposition: "definite_rejection", retryable: true }
  }
  if (status !== null && status >= 400 && status < 500 && status !== 408) {
    return { disposition: "definite_rejection", retryable: false }
  }
  return { disposition: "outcome_unknown", retryable: true }
}

export async function createTicketPage(
  notion: NotionClientLike,
  input: CreateTicketPageInput
): Promise<TicketPageReference> {
  const sourceKey = boundedPlainText(
    input.sourceKey,
    PROPERTY_NAMES.sourceKey,
    MAX_SOURCE_KEY_LENGTH
  )
  const title = boundedPlainText(input.title, "Ticket title", MAX_TITLE_LENGTH)
  const customer =
    input.customer === null
      ? null
      : boundedPlainText(
          input.customer,
          PROPERTY_NAMES.customer,
          MAX_PERSON_LENGTH
        )
  const company =
    input.company === null
      ? null
      : boundedPlainText(
          input.company,
          PROPERTY_NAMES.company,
          MAX_PERSON_LENGTH
        )
  const intercomUpdatedAt = normalizedIsoDate(
    input.intercomUpdatedAt,
    PROPERTY_NAMES.intercomUpdated
  )
  if (!PRIORITIES.includes(input.priority)) {
    throw new NotionAdapterError(
      "NOTION_INPUT_INVALID",
      "Priority must be P0, P1, P2, or P3."
    )
  }
  normalizeNotionId(input.schema.dataSourceId, "Notion ticket data source ID")
  const children = ticketBlocks(input.body)

  let created: unknown
  try {
    created = await notion.pages.create({
      parent: {
        type: "data_source_id",
        data_source_id: input.schema.dataSourceId,
      },
      properties: {
        [input.schema.title.id]: { title: richTextRequest(title) },
        [input.schema.sourceKey.id]: { rich_text: richTextRequest(sourceKey) },
        [input.schema.priority.id]: {
          select: { id: input.schema.priorityOptionIds[input.priority] },
        },
        [input.schema.customer.id]: { rich_text: richTextRequest(customer) },
        [input.schema.company.id]: { rich_text: richTextRequest(company) },
        [input.schema.intercomUpdated.id]: {
          date: { start: intercomUpdatedAt },
        },
      },
      children,
    })
  } catch (error) {
    if (error instanceof NotionAdapterError) throw error
    const classified = classifyCreateError(error)
    throw new NotionCreateError(classified.disposition, classified.retryable)
  }

  if (!created || typeof created !== "object" || Array.isArray(created)) {
    throw new NotionCreateError("outcome_unknown")
  }
  const createdRecord = created as Record<string, unknown>
  if (createdRecord.object !== "page" || typeof createdRecord.id !== "string") {
    throw new NotionCreateError("outcome_unknown")
  }
  try {
    return await retrieveAndVerifyTicketPage(
      notion,
      input.schema,
      createdRecord.id,
      sourceKey
    )
  } catch {
    // A create response with a page ID proves that Notion accepted the write,
    // but an unverified readback still requires live reconciliation before any
    // later create attempt.
    throw new NotionCreateError("outcome_unknown", true, createdRecord.id)
  }
}

export async function retrieveAndVerifyTicketPage(
  notion: NotionClientLike,
  schema: TicketDataSourceSchema,
  pageId: string,
  expectedSourceKeyValue: string
): Promise<TicketPageReference> {
  normalizeNotionId(schema.dataSourceId, "Notion ticket data source ID")
  normalizeNotionId(pageId, "Notion ticket page ID")
  const expectedSourceKey = boundedPlainText(
    expectedSourceKeyValue,
    PROPERTY_NAMES.sourceKey,
    MAX_SOURCE_KEY_LENGTH
  )
  const page = await readCall(() => notion.pages.retrieve({ page_id: pageId }))
  return parseVerifiedTicketPage(page, schema, expectedSourceKey, pageId)
}
