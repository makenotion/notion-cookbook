// Entry point — registers one connected Intercom support workspace in Notion.
// Resource modules own their transforms and pagination behavior; this file
// keeps only database registration, schedules, pacing, and process-local lookup
// caches.

import { Worker } from "@notionhq/workers"

import {
  INITIAL_TITLE as COMPANIES_TITLE,
  PRIMARY_KEY as COMPANIES_PK,
  companySchema,
  runCompaniesPage,
  type CompanySyncState,
} from "./companies.js"
import {
  INITIAL_TITLE as CONTACTS_TITLE,
  PRIMARY_KEY as CONTACTS_PK,
  contactSchema,
  runContactsPage,
} from "./contacts.js"
import {
  INITIAL_TITLE as CONVERSATIONS_TITLE,
  PRIMARY_KEY as CONVERSATIONS_PK,
  conversationSchema,
  runConversationIncrementalPage,
  runConversationReconciliationPage,
  type ConversationIncrementalState,
  type ConversationReconciliationState,
} from "./conversations.js"
import {
  createIntercomClient,
  type AssignmentDirectory,
  type ContactDirectory,
} from "./intercom.js"
import {
  INITIAL_TITLE as TICKETS_TITLE,
  PRIMARY_KEY as TICKETS_PK,
  runTicketIncrementalPage,
  runTicketReconciliationPage,
  ticketSchema,
  type TicketIncrementalState,
  type TicketReconciliationState,
} from "./tickets.js"
import type { CursorSyncState } from "./pagination.js"

const worker = new Worker()

// Intercom applies app-wide quotas in ten-second windows. This shared pacer
// leaves headroom below the default quota; HTTP 429 responses also surface the
// provider's reset time through RateLimitError.
const pacer = worker.pacer("intercom", {
  allowedRequests: 1_000,
  intervalMs: 10_000,
})
const createClient = () => createIntercomClient(() => pacer.wait())

type CycleCache<T> = {
  get(load: () => Promise<T>): Promise<T>
  clear(): void
}

export function createCycleCache<T>(): CycleCache<T> {
  let current: Promise<T> | undefined
  return {
    get(load) {
      if (current) return current

      const request = load().catch((error: unknown) => {
        if (current === request) current = undefined
        throw error
      })
      current = request
      return request
    },
    clear() {
      current = undefined
    },
  }
}

// Each capability gets its own process-local lookup cache. A warm process can
// reuse a directory across continuation pages or retries, but correctness never
// depends on that memory: a cold invocation refetches it. Terminal pages clear
// the cached value so the next cycle sees current lookup data.
const contactDirectories = createCycleCache<ContactDirectory>()
const incrementalConversationDirectories =
  createCycleCache<AssignmentDirectory>()
const reconciliationConversationDirectories =
  createCycleCache<AssignmentDirectory>()
const incrementalTicketDirectories = createCycleCache<AssignmentDirectory>()
const reconciliationTicketDirectories = createCycleCache<AssignmentDirectory>()

// ---------------------------------------------------------------------------
// Companies — the only capability that owns Intercom's single active company
// scroll. Contacts and Conversations relate to these records by immutable ID.
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
  schedule: "1h",
  execute: (state: CompanySyncState | undefined) =>
    runCompaniesPage(createClient(), state),
})

// ---------------------------------------------------------------------------
// Contacts — a full replacement avoids unsafe day-granularity search cursors
// and removes contacts that were merged or are no longer visible.
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
  schedule: "1h",
  execute: async (state: CursorSyncState | undefined) => {
    if (!state) contactDirectories.clear()
    const client = createClient()
    const directory = await contactDirectories.get(() =>
      client.fetchContactDirectory()
    )
    const result = await runContactsPage(client, directory, state)
    if (!result.hasMore) contactDirectories.clear()
    return result
  },
})

// ---------------------------------------------------------------------------
// Conversations — Contact IDs become relations to the Contacts database.
// ---------------------------------------------------------------------------

const conversations = worker.database("conversations", {
  type: "managed",
  initialTitle: CONVERSATIONS_TITLE,
  primaryKeyProperty: CONVERSATIONS_PK,
  schema: conversationSchema,
})

worker.sync("conversationsSync", {
  database: conversations,
  mode: "incremental",
  schedule: "5m",
  execute: async (state: ConversationIncrementalState | undefined) => {
    if (!state?.after) incrementalConversationDirectories.clear()
    const client = createClient()
    const directory = await incrementalConversationDirectories.get(() =>
      client.fetchAssignmentDirectory()
    )
    const result = await runConversationIncrementalPage(
      client,
      directory,
      state
    )
    if (!result.hasMore) incrementalConversationDirectories.clear()
    return result
  },
})

worker.sync("conversationsReconciliation", {
  database: conversations,
  mode: "replace",
  schedule: "1d",
  execute: async (state: ConversationReconciliationState | undefined) => {
    if (!state) reconciliationConversationDirectories.clear()
    const client = createClient()
    const directory = await reconciliationConversationDirectories.get(() =>
      client.fetchAssignmentDirectory()
    )
    const result = await runConversationReconciliationPage(
      client,
      directory,
      state
    )
    if (!result.hasMore) reconciliationConversationDirectories.clear()
    return result
  },
})

// ---------------------------------------------------------------------------
// Tickets — optional in Intercom plans, but included in the same deploy. Keep
// both Ticket schedules paused when the workspace does not have API access.
// ---------------------------------------------------------------------------

const tickets = worker.database("tickets", {
  type: "managed",
  initialTitle: TICKETS_TITLE,
  primaryKeyProperty: TICKETS_PK,
  schema: ticketSchema,
})

worker.sync("ticketsSync", {
  database: tickets,
  mode: "incremental",
  schedule: "5m",
  execute: async (state: TicketIncrementalState | undefined) => {
    if (!state?.after) incrementalTicketDirectories.clear()
    const client = createClient()
    const directory = await incrementalTicketDirectories.get(() =>
      client.fetchAssignmentDirectory()
    )
    const result = await runTicketIncrementalPage(client, directory, state)
    if (!result.hasMore) incrementalTicketDirectories.clear()
    return result
  },
})

worker.sync("ticketsReconciliation", {
  database: tickets,
  mode: "replace",
  schedule: "1d",
  execute: async (state: TicketReconciliationState | undefined) => {
    if (!state) reconciliationTicketDirectories.clear()
    const client = createClient()
    const directory = await reconciliationTicketDirectories.get(() =>
      client.fetchAssignmentDirectory()
    )
    const result = await runTicketReconciliationPage(client, directory, state)
    if (!result.hasMore) reconciliationTicketDirectories.clear()
    return result
  },
})

export default worker
