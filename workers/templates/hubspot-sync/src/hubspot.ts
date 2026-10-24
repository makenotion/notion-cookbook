// HubSpot CRM API client. Handles authentication and paginated fetching
// for contacts, deals, companies, owners, and pipeline definitions.
//
// To add a new resource:
//   1. Add a type for the properties you need
//   2. Add a fetchXxxPage() function with the right properties list
//   3. Wire it into index.ts

const PER_PAGE = 100
const ASSOCIATION_BATCH_SIZE = 100
const API_ROOT = "https://api.hubapi.com"

export type BeforeRequest = () => Promise<void>

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is not set.`)
  }
  return value
}

export function getPortalId(): string {
  return requireEnv("HUBSPOT_PORTAL_ID")
}

function getToken(): string {
  return requireEnv("HUBSPOT_ACCESS_TOKEN")
}

async function fetchJson<T>(
  url: string,
  beforeRequest: BeforeRequest,
  init?: RequestInit
): Promise<T> {
  const token = getToken()
  const headers = new Headers(init?.headers)
  headers.set("Authorization", `Bearer ${token}`)
  headers.set("Accept", "application/json")

  await beforeRequest()
  const response = await fetch(url, {
    ...init,
    headers,
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `HubSpot API error (${response.status}): ${text || "No response body"}`
    )
  }

  return JSON.parse(text) as T
}

// HubSpot CRM objects share a common response shape.
type CrmListResponse<T> = {
  results: {
    id: string
    properties: T
    createdAt: string
    updatedAt: string
    archived: boolean
  }[]
  paging?: {
    next?: { after: string }
  }
}

export type CrmRecord<T> = {
  id: string
  properties: T
  associations: Record<string, string[]>
  createdAt: string
  updatedAt: string
}

type AssociationBatchInput = {
  id: string
  after?: string
}

type AssociationBatchResponse = {
  results: {
    from: { id: string }
    to: { toObjectId: string }[]
    paging?: { next?: { after: string } }
  }[]
}

async function fetchAllAssociations(
  fromObjectType: string,
  toObjectType: string,
  recordIds: string[],
  beforeRequest: BeforeRequest
): Promise<Map<string, string[]>> {
  const uniqueIds = [...new Set(recordIds)]
  const associations = new Map<string, Set<string>>(
    uniqueIds.map((id) => [id, new Set<string>()])
  )
  const seenCursors = new Set<string>()
  let pending: AssociationBatchInput[] = uniqueIds.map((id) => ({ id }))

  while (pending.length > 0) {
    const next: AssociationBatchInput[] = []

    for (
      let index = 0;
      index < pending.length;
      index += ASSOCIATION_BATCH_SIZE
    ) {
      const inputs = pending.slice(index, index + ASSOCIATION_BATCH_SIZE)
      const body = await fetchJson<AssociationBatchResponse>(
        `${API_ROOT}/crm/associations/2026-03/${fromObjectType}/${toObjectType}/batch/read`,
        beforeRequest,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inputs }),
        }
      )

      for (const result of body.results) {
        const ids = associations.get(result.from.id) ?? new Set<string>()
        for (const association of result.to) {
          ids.add(association.toObjectId)
        }
        associations.set(result.from.id, ids)

        const after = result.paging?.next?.after
        if (after) {
          const cursorKey = `${result.from.id}:${after}`
          if (seenCursors.has(cursorKey)) {
            throw new Error(
              `HubSpot repeated association cursor for ${fromObjectType} ${result.from.id}`
            )
          }
          seenCursors.add(cursorKey)
          next.push({ id: result.from.id, after })
        }
      }
    }

    pending = next
  }

  return new Map(
    [...associations].map(([recordId, ids]) => [recordId, [...ids]])
  )
}

async function fetchCrmPage<T>(
  objectType: string,
  properties: string[],
  beforeRequest: BeforeRequest,
  cursor?: string
): Promise<{ records: CrmRecord<T>[]; nextCursor: string | undefined }> {
  const url = new URL(`${API_ROOT}/crm/objects/2026-03/${objectType}`)
  url.searchParams.set("limit", String(PER_PAGE))
  url.searchParams.set("properties", properties.join(","))
  if (cursor) {
    url.searchParams.set("after", cursor)
  }

  const body = await fetchJson<CrmListResponse<T>>(
    url.toString(),
    beforeRequest
  )
  const records = body.results
    .filter((r) => !r.archived)
    .map((r) => ({
      id: r.id,
      properties: r.properties,
      associations: {},
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }))

  return {
    records,
    nextCursor: body.paging?.next?.after,
  }
}

// ---------------------------------------------------------------------------
// Owners — fetched once per sync cycle to resolve hubspot_owner_id to names
// ---------------------------------------------------------------------------

export type HubSpotOwner = {
  id: string
  firstName?: string | null
  lastName?: string | null
  email?: string | null
}

export type OwnerLookup = Map<string, HubSpotOwner>

export async function fetchAllOwners(
  beforeRequest: BeforeRequest
): Promise<OwnerLookup> {
  const owners: OwnerLookup = new Map()

  // Records can remain assigned to deactivated owners. HubSpot exposes active
  // and archived owners as separate result sets, so fetch both.
  for (const archived of [false, true]) {
    let after: string | undefined

    do {
      const url = new URL(`${API_ROOT}/crm/owners/2026-03`)
      url.searchParams.set("limit", String(PER_PAGE))
      url.searchParams.set("archived", String(archived))
      if (after) url.searchParams.set("after", after)

      const body = await fetchJson<{
        results: HubSpotOwner[]
        paging?: { next?: { after: string } }
      }>(url.toString(), beforeRequest)

      for (const owner of body.results) {
        owners.set(owner.id, owner)
      }

      after = body.paging?.next?.after
    } while (after)
  }

  return owners
}

export function ownerName(
  owners: OwnerLookup,
  id: string | null
): string | null {
  if (!id) return null
  const owner = owners.get(id)
  if (!owner) return null
  const name = [owner.firstName, owner.lastName]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(" ")
  return name || owner.email?.trim() || null
}

// ---------------------------------------------------------------------------
// Pipelines — fetched once per sync cycle to resolve stage/pipeline IDs
// https://developers.hubspot.com/docs/reference/api/crm/pipelines
// ---------------------------------------------------------------------------

export type PipelineLookup = {
  pipelineName: (id: string) => string | null
  stageName: (stageId: string) => string | null
}

type PipelineResponse = {
  results: {
    id: string
    label: string
    stages: { id: string; label: string }[]
  }[]
}

export async function fetchDealPipelines(
  beforeRequest: BeforeRequest
): Promise<PipelineLookup> {
  const body = await fetchJson<PipelineResponse>(
    `${API_ROOT}/crm/pipelines/2026-03/deals`,
    beforeRequest
  )

  const pipelines = new Map<string, string>()
  const stages = new Map<string, string>()

  for (const pipeline of body.results) {
    pipelines.set(pipeline.id, pipeline.label)
    for (const stage of pipeline.stages) {
      stages.set(stage.id, stage.label)
    }
  }

  return {
    pipelineName: (id) => pipelines.get(id) ?? null,
    stageName: (id) => stages.get(id) ?? null,
  }
}

// ---------------------------------------------------------------------------
// Contacts
// https://developers.hubspot.com/docs/api/crm/contacts
// ---------------------------------------------------------------------------

export type HubSpotContact = {
  firstname: string | null
  lastname: string | null
  email: string | null
  phone: string | null
  company: string | null
  jobtitle: string | null
  lifecyclestage: string | null
  hs_lead_status: string | null
  hubspot_owner_id: string | null
  notes_last_updated: string | null
  num_associated_deals: string | null
  recent_deal_amount: string | null
  createdate: string | null
}

const CONTACT_PROPERTIES = [
  "firstname",
  "lastname",
  "email",
  "phone",
  "company",
  "jobtitle",
  "lifecyclestage",
  "hs_lead_status",
  "hubspot_owner_id",
  "notes_last_updated",
  "num_associated_deals",
  "recent_deal_amount",
  "createdate",
]

export async function fetchContactsPage(
  beforeRequest: BeforeRequest,
  cursor?: string
): Promise<{
  contacts: CrmRecord<HubSpotContact>[]
  nextCursor: string | undefined
}> {
  const { records, nextCursor } = await fetchCrmPage<HubSpotContact>(
    "contacts",
    CONTACT_PROPERTIES,
    beforeRequest,
    cursor
  )
  return { contacts: records, nextCursor }
}

// ---------------------------------------------------------------------------
// Deals
// https://developers.hubspot.com/docs/api/crm/deals
// ---------------------------------------------------------------------------

export type HubSpotDeal = {
  dealname: string | null
  dealstage: string | null
  pipeline: string | null
  amount: string | null
  closedate: string | null
  hubspot_owner_id: string | null
  dealtype: string | null
  hs_forecast_amount: string | null
  hs_forecast_category: string | null
  hs_is_closed_won: string | null
  description: string | null
  createdate: string | null
}

const DEAL_PROPERTIES = [
  "dealname",
  "dealstage",
  "pipeline",
  "amount",
  "closedate",
  "hubspot_owner_id",
  "dealtype",
  "hs_forecast_amount",
  "hs_forecast_category",
  "hs_is_closed_won",
  "description",
  "createdate",
]

export async function fetchDealsPage(
  beforeRequest: BeforeRequest,
  cursor?: string
): Promise<{
  deals: CrmRecord<HubSpotDeal>[]
  nextCursor: string | undefined
}> {
  const { records, nextCursor } = await fetchCrmPage<HubSpotDeal>(
    "deals",
    DEAL_PROPERTIES,
    beforeRequest,
    cursor
  )

  const dealIds = records.map((deal) => deal.id)
  const [companies, contacts] = await Promise.all([
    fetchAllAssociations("deals", "companies", dealIds, beforeRequest),
    fetchAllAssociations("deals", "contacts", dealIds, beforeRequest),
  ])
  const deals = records.map((deal) => ({
    ...deal,
    associations: {
      ...deal.associations,
      companies: companies.get(deal.id) ?? [],
      contacts: contacts.get(deal.id) ?? [],
    },
  }))

  return { deals, nextCursor }
}

// ---------------------------------------------------------------------------
// Companies
// https://developers.hubspot.com/docs/api/crm/companies
// ---------------------------------------------------------------------------

export type HubSpotCompany = {
  name: string | null
  domain: string | null
  description: string | null
  industry: string | null
  numberofemployees: string | null
  annualrevenue: string | null
  hubspot_owner_id: string | null
  type: string | null
  city: string | null
  country: string | null
  phone: string | null
  lifecyclestage: string | null
  hs_num_open_deals: string | null
  total_revenue: string | null
  createdate: string | null
}

const COMPANY_PROPERTIES = [
  "name",
  "domain",
  "description",
  "industry",
  "numberofemployees",
  "annualrevenue",
  "hubspot_owner_id",
  "type",
  "city",
  "country",
  "phone",
  "lifecyclestage",
  "hs_num_open_deals",
  "total_revenue",
  "createdate",
]

export async function fetchCompaniesPage(
  beforeRequest: BeforeRequest,
  cursor?: string
): Promise<{
  companies: CrmRecord<HubSpotCompany>[]
  nextCursor: string | undefined
}> {
  const { records, nextCursor } = await fetchCrmPage<HubSpotCompany>(
    "companies",
    COMPANY_PROPERTIES,
    beforeRequest,
    cursor
  )
  return { companies: records, nextCursor }
}
