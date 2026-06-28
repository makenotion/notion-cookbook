// Entry point — syncs HubSpot CRM contacts, deals, and companies into
// managed Notion databases.
//
// Three databases are created:
//   1. Contacts   — lifecycle stage, lead status, owner (every 5 min)
//   2. Deals      — pipeline stage, amount, associations, forecast (every 5 min)
//   3. Companies  — industry, revenue, employees, open deals (every 5 min)
//
// Owner IDs and pipeline/stage IDs are resolved to human-readable names by
// fetching lookup data once at the start of each sync cycle.
// Deal associations (company/contact) are resolved per-page using batch reads.

import { Worker } from "@notionhq/workers"

import {
  getPortalId,
  fetchAllOwners,
  fetchDealPipelines,
  fetchContactsPage,
  fetchDealsPage,
  fetchCompaniesPage,
  batchReadNames,
} from "./hubspot.js"
import type { OwnerLookup, PipelineLookup } from "./hubspot.js"
import {
  INITIAL_TITLE as CONTACTS_TITLE,
  PRIMARY_KEY as CONTACTS_PK,
  contactSchema,
  contactToChange,
} from "./contacts.js"
import {
  INITIAL_TITLE as DEALS_TITLE,
  PRIMARY_KEY as DEALS_PK,
  dealSchema,
  dealToChange,
} from "./deals.js"
import type { DealContext } from "./deals.js"
import {
  INITIAL_TITLE as COMPANIES_TITLE,
  PRIMARY_KEY as COMPANIES_PK,
  companySchema,
  companyToChange,
} from "./companies.js"

type SyncState = {
  cursor: string
}

const worker = new Worker()

// HubSpot rate-limits to 100 requests per 10 seconds on Free/Starter plans.
const pacer = worker.pacer("hubspot", {
  allowedRequests: 90,
  intervalMs: 10_000,
})

// Per-cycle caches cleared when the last page completes.
let contactOwners: OwnerLookup | undefined
let companyOwners: OwnerLookup | undefined
let dealOwners: OwnerLookup | undefined
let dealPipelines: PipelineLookup | undefined

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

const contacts = worker.database("contacts", {
  type: "managed",
  initialTitle: CONTACTS_TITLE,
  primaryKeyProperty: CONTACTS_PK,
  schema: contactSchema,
})

worker.sync("contactsSync", {
  database: contacts,
  mode: "replace",
  schedule: "5m",
  execute: async (state: SyncState | undefined) => {
    await pacer.wait()
    const portalId = getPortalId()

    if (!contactOwners) {
      contactOwners = await fetchAllOwners()
    }

    const page = await fetchContactsPage(state?.cursor)
    const changes = page.contacts.map((c) =>
      contactToChange(c.id, c.properties, c.updatedAt, portalId, contactOwners!)
    )

    if (page.nextCursor) {
      return {
        changes,
        hasMore: true,
        nextState: { cursor: page.nextCursor },
      }
    }

    contactOwners = undefined
    return { changes, hasMore: false }
  },
})

// ---------------------------------------------------------------------------
// Deals — resolves stage/pipeline IDs and association IDs to names
// ---------------------------------------------------------------------------

const deals = worker.database("deals", {
  type: "managed",
  initialTitle: DEALS_TITLE,
  primaryKeyProperty: DEALS_PK,
  schema: dealSchema,
})

worker.sync("dealsSync", {
  database: deals,
  mode: "replace",
  schedule: "2m",
  execute: async (state: SyncState | undefined) => {
    await pacer.wait()
    const portalId = getPortalId()

    if (!dealOwners) {
      const [owners, pipelines] = await Promise.all([
        fetchAllOwners(),
        fetchDealPipelines(),
      ])
      dealOwners = owners
      dealPipelines = pipelines
    }

    const page = await fetchDealsPage(state?.cursor)

    const companyIds: string[] = []
    const contactIds: string[] = []
    for (const d of page.deals) {
      const cid = d.associations["companies"]?.[0]
      const tid = d.associations["contacts"]?.[0]
      if (cid) companyIds.push(cid)
      if (tid) contactIds.push(tid)
    }

    await pacer.wait()
    const [companyNames, contactNames] = await Promise.all([
      batchReadNames("companies", companyIds, ["name"]),
      batchReadNames("contacts", contactIds, ["firstname", "lastname"], (props) => {
        const name = `${props.firstname ?? ""} ${props.lastname ?? ""}`.trim()
        return name || null
      }),
    ])

    const ctx: DealContext = {
      portalId,
      owners: dealOwners!,
      pipelines: dealPipelines!,
      companyNames,
      contactNames,
    }

    const changes = page.deals.map((d) =>
      dealToChange(d.id, d.properties, d.updatedAt, d.associations, ctx)
    )

    if (page.nextCursor) {
      return {
        changes,
        hasMore: true,
        nextState: { cursor: page.nextCursor },
      }
    }

    dealOwners = undefined
    dealPipelines = undefined
    return { changes, hasMore: false }
  },
})

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

const companies = worker.database("companies", {
  type: "managed",
  initialTitle: COMPANIES_TITLE,
  primaryKeyProperty: COMPANIES_PK,
  schema: companySchema,
})

worker.sync("companiesSync", {
  database: companies,
  mode: "replace",
  schedule: "5m",
  execute: async (state: SyncState | undefined) => {
    await pacer.wait()
    const portalId = getPortalId()

    if (!companyOwners) {
      companyOwners = await fetchAllOwners()
    }

    const page = await fetchCompaniesPage(state?.cursor)
    const changes = page.companies.map((c) =>
      companyToChange(c.id, c.properties, c.updatedAt, portalId, companyOwners!)
    )

    if (page.nextCursor) {
      return {
        changes,
        hasMore: true,
        nextState: { cursor: page.nextCursor },
      }
    }

    companyOwners = undefined
    return { changes, hasMore: false }
  },
})

export default worker
