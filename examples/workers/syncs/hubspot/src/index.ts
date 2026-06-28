// Entry point — syncs HubSpot CRM contacts, deals, and companies into
// managed Notion databases.
//
// Three databases are created:
//   1. Contacts   — lifecycle stage, lead status, owner (every 5 min)
//   2. Deals      — pipeline stage, amount, close date, owner (every 5 min)
//   3. Companies  — industry, revenue, employees, owner (every 5 min)
//
// Owner IDs are resolved to names by fetching all owners once per sync cycle.

import { Worker } from "@notionhq/workers"

import {
  getPortalId,
  fetchAllOwners,
  fetchContactsPage,
  fetchDealsPage,
  fetchCompaniesPage,
} from "./hubspot.js"
import type { OwnerLookup } from "./hubspot.js"
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

// Owners are fetched once per sync cycle and shared across all transforms.
let cachedOwners: OwnerLookup | undefined

async function getOwners(): Promise<OwnerLookup> {
  if (!cachedOwners) {
    cachedOwners = await fetchAllOwners()
  }
  return cachedOwners
}

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
    const owners = await getOwners()

    const page = await fetchContactsPage(state?.cursor)
    const changes = page.contacts.map((c) =>
      contactToChange(c.id, c.properties, c.updatedAt, portalId, owners)
    )

    if (page.nextCursor) {
      return {
        changes,
        hasMore: true,
        nextState: { cursor: page.nextCursor },
      }
    }

    cachedOwners = undefined
    return { changes, hasMore: false }
  },
})

// ---------------------------------------------------------------------------
// Deals
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
  schedule: "5m",
  execute: async (state: SyncState | undefined) => {
    await pacer.wait()
    const portalId = getPortalId()
    const owners = await getOwners()

    const page = await fetchDealsPage(state?.cursor)
    const changes = page.deals.map((d) =>
      dealToChange(d.id, d.properties, d.updatedAt, portalId, owners)
    )

    if (page.nextCursor) {
      return {
        changes,
        hasMore: true,
        nextState: { cursor: page.nextCursor },
      }
    }

    cachedOwners = undefined
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
    const owners = await getOwners()

    const page = await fetchCompaniesPage(state?.cursor)
    const changes = page.companies.map((c) =>
      companyToChange(c.id, c.properties, c.updatedAt, portalId, owners)
    )

    if (page.nextCursor) {
      return {
        changes,
        hasMore: true,
        nextState: { cursor: page.nextCursor },
      }
    }

    cachedOwners = undefined
    return { changes, hasMore: false }
  },
})

export default worker
