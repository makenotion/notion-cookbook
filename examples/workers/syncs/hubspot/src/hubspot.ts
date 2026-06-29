// HubSpot CRM API client. Handles authentication and paginated fetching
// for contacts, deals, companies, owners, and pipeline definitions.
//
// To add a new resource:
//   1. Add a type for the properties you need
//   2. Add a fetchXxxPage() function with the right properties list
//   3. Wire it into index.ts

const PER_PAGE = 100

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

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: "application/json",
    },
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
    associations?: Record<string, { results: { id: string }[] }>
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

async function fetchCrmPage<T>(
  objectType: string,
  properties: string[],
  cursor?: string,
  associations?: string[]
): Promise<{ records: CrmRecord<T>[]; nextCursor: string | undefined }> {
  const url = new URL(`https://api.hubapi.com/crm/v3/objects/${objectType}`)
  url.searchParams.set("limit", String(PER_PAGE))
  url.searchParams.set("properties", properties.join(","))
  if (associations?.length) {
    url.searchParams.set("associations", associations.join(","))
  }
  if (cursor) {
    url.searchParams.set("after", cursor)
  }

  const body = await fetchJson<CrmListResponse<T>>(url.toString())
  const records = body.results
    .filter((r) => !r.archived)
    .map((r) => {
      const assoc: Record<string, string[]> = {}
      if (r.associations) {
        for (const [key, val] of Object.entries(r.associations)) {
          assoc[key] = val.results.map((a) => a.id)
        }
      }
      return {
        id: r.id,
        properties: r.properties,
        associations: assoc,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }
    })

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
  firstName: string
  lastName: string
  email: string
}

export type OwnerLookup = Map<string, HubSpotOwner>

export async function fetchAllOwners(): Promise<OwnerLookup> {
  const owners: OwnerLookup = new Map()
  let after: string | undefined

  do {
    const url = new URL("https://api.hubapi.com/crm/v3/owners")
    url.searchParams.set("limit", String(PER_PAGE))
    if (after) url.searchParams.set("after", after)

    const body = await fetchJson<{
      results: HubSpotOwner[]
      paging?: { next?: { after: string } }
    }>(url.toString())

    for (const owner of body.results) {
      owners.set(owner.id, owner)
    }

    after = body.paging?.next?.after
  } while (after)

  return owners
}

export function ownerName(owners: OwnerLookup, id: string | null): string | null {
  if (!id) return null
  const owner = owners.get(id)
  if (!owner) return null
  const name = `${owner.firstName} ${owner.lastName}`.trim()
  return name || owner.email || null
}

// ---------------------------------------------------------------------------
// Batch read — resolve a set of record IDs to their properties in one call
// https://developers.hubspot.com/docs/api/crm/contacts#batch
// ---------------------------------------------------------------------------

export type NameLookup = Map<string, string>

export async function batchReadNames(
  objectType: string,
  ids: string[],
  nameProperties: string[],
  formatter?: (props: Record<string, string | null>) => string | null
): Promise<NameLookup> {
  const names: NameLookup = new Map()
  if (ids.length === 0) return names

  const unique = [...new Set(ids)]
  const url = `https://api.hubapi.com/crm/v3/objects/${objectType}/batch/read`

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      properties: nameProperties,
      inputs: unique.map((id) => ({ id })),
    }),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `HubSpot API error (${response.status}): ${text || "No response body"}`
    )
  }

  const body = JSON.parse(text) as {
    results: { id: string; properties: Record<string, string | null> }[]
  }

  for (const record of body.results) {
    const name = formatter
      ? formatter(record.properties)
      : record.properties[nameProperties[0]]
    if (name) names.set(record.id, name)
  }

  return names
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

export async function fetchDealPipelines(): Promise<PipelineLookup> {
  const body = await fetchJson<PipelineResponse>(
    "https://api.hubapi.com/crm/v3/pipelines/deals"
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
  hs_last_sales_activity_timestamp: string | null
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
  "hs_last_sales_activity_timestamp",
  "num_associated_deals",
  "recent_deal_amount",
  "createdate",
]

export async function fetchContactsPage(cursor?: string): Promise<{
  contacts: CrmRecord<HubSpotContact>[]
  nextCursor: string | undefined
}> {
  const { records, nextCursor } = await fetchCrmPage<HubSpotContact>(
    "contacts",
    CONTACT_PROPERTIES,
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

export async function fetchDealsPage(cursor?: string): Promise<{
  deals: CrmRecord<HubSpotDeal>[]
  nextCursor: string | undefined
}> {
  const { records, nextCursor } = await fetchCrmPage<HubSpotDeal>(
    "deals",
    DEAL_PROPERTIES,
    cursor,
    ["companies", "contacts"]
  )
  return { deals: records, nextCursor }
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

export async function fetchCompaniesPage(cursor?: string): Promise<{
  companies: CrmRecord<HubSpotCompany>[]
  nextCursor: string | undefined
}> {
  const { records, nextCursor } = await fetchCrmPage<HubSpotCompany>(
    "companies",
    COMPANY_PROPERTIES,
    cursor
  )
  return { companies: records, nextCursor }
}
