// HubSpot CRM API client. Handles authentication and paginated fetching
// for contacts, deals, companies, and owners.
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

type CrmRecord<T> = {
  id: string
  properties: T
  createdAt: string
  updatedAt: string
}

async function fetchCrmPage<T>(
  objectType: string,
  properties: string[],
  cursor?: string
): Promise<{ records: CrmRecord<T>[]; nextCursor: string | undefined }> {
  const token = requireEnv("HUBSPOT_ACCESS_TOKEN")
  const url = new URL(`https://api.hubapi.com/crm/v3/objects/${objectType}`)
  url.searchParams.set("limit", String(PER_PAGE))
  url.searchParams.set("properties", properties.join(","))
  if (cursor) {
    url.searchParams.set("after", cursor)
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `HubSpot API error (${response.status}): ${text || "No response body"}`
    )
  }

  const body = JSON.parse(text) as CrmListResponse<T>
  const records = body.results
    .filter((r) => !r.archived)
    .map((r) => ({
      id: r.id,
      properties: r.properties,
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
  firstName: string
  lastName: string
  email: string
}

export type OwnerLookup = Map<string, HubSpotOwner>

export async function fetchAllOwners(): Promise<OwnerLookup> {
  const token = requireEnv("HUBSPOT_ACCESS_TOKEN")
  const owners: OwnerLookup = new Map()
  let after: string | undefined

  do {
    const url = new URL("https://api.hubapi.com/crm/v3/owners")
    url.searchParams.set("limit", String(PER_PAGE))
    if (after) url.searchParams.set("after", after)

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    })

    const text = await response.text()
    if (!response.ok) {
      throw new Error(
        `HubSpot API error (${response.status}): ${text || "No response body"}`
      )
    }

    const body = JSON.parse(text) as {
      results: HubSpotOwner[]
      paging?: { next?: { after: string } }
    }

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
  "createdate",
]

export async function fetchDealsPage(cursor?: string): Promise<{
  deals: CrmRecord<HubSpotDeal>[]
  nextCursor: string | undefined
}> {
  const { records, nextCursor } = await fetchCrmPage<HubSpotDeal>(
    "deals",
    DEAL_PROPERTIES,
    cursor
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
  industry: string | null
  numberofemployees: string | null
  annualrevenue: string | null
  hubspot_owner_id: string | null
  type: string | null
  city: string | null
  country: string | null
  phone: string | null
  lifecyclestage: string | null
  createdate: string | null
}

const COMPANY_PROPERTIES = [
  "name",
  "domain",
  "industry",
  "numberofemployees",
  "annualrevenue",
  "hubspot_owner_id",
  "type",
  "city",
  "country",
  "phone",
  "lifecyclestage",
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
