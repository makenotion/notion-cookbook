import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

import {
  type AssignmentDirectory,
  type IntercomClient,
  type IntercomTicket,
} from "./intercom.js"
import {
  escapeMarkdown,
  htmlToPlainText,
  humanize,
  nonEmpty,
  optionalUnixSecondsToIso,
  uniqueStrings,
  unixSecondsToIso,
} from "./helpers.js"
import {
  lastAscendingRecordId,
  nextCursorState,
  validatedPageCount,
  validatedRecentCursors,
  type CursorSyncState,
} from "./pagination.js"

export const INITIAL_TITLE = "Intercom Tickets"
export const PRIMARY_KEY = "Ticket ID"

export const ticketSchema = {
  databaseIcon: notionIcon("ticket"),
  properties: {
    Title: Schema.title(),

    State: Schema.select([]),

    "State Category": Schema.select([
      { name: "Submitted" },
      { name: "In Progress" },
      { name: "Waiting On Customer" },
      { name: "Resolved" },
    ]),

    "Ticket Type": Schema.select([]),

    Category: Schema.select([
      { name: "Customer" },
      { name: "Back Office" },
      { name: "Tracker" },
    ]),

    Contacts: Schema.relation("contacts", {
      twoWay: true,
      relatedPropertyName: "Tickets",
    }),

    Assignee: Schema.richText(),

    Team: Schema.richText(),

    Updated: Schema.date(),

    Open: Schema.checkbox(),

    "Snoozed Until": Schema.date(),

    "Shared with Customer": Schema.checkbox(),

    Created: Schema.date(),

    "Inbox Ticket ID": Schema.richText(),

    "Ticket ID": Schema.richText(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

export type TicketIncrementalState = {
  since: number
  until?: number
  after?: string
  recentCursors?: string[]
  pageCount?: number
  lastRecordId?: string
}

export type TicketReconciliationState = CursorSyncState & {
  createdBefore?: number
  expectedTotalCount: number
  seenCount: number
  recentRecordIds: string[]
  lastRecordId?: string
}

export const INITIAL_TICKET_WATERMARK = 0
export const TICKET_CONSISTENCY_BUFFER_SECONDS = 60
export const TICKET_WATERMARK_OVERLAP_SECONDS = 5 * 60
const MAX_RECENT_TICKET_IDS = 300

function ticketId(ticket: IntercomTicket): string {
  const id = nonEmpty(ticket.id)
  if (!id) throw new Error("Intercom ticket is missing its id.")
  return id
}

function attributeText(value: unknown): string | undefined {
  if (typeof value === "string") return nonEmpty(value)
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (typeof value === "boolean") return String(value)
  return undefined
}

function ticketTitle(ticket: IntercomTicket): string {
  const title = attributeText(ticket.ticket_attributes?._default_title_)
  if (title) return title
  const type = nonEmpty(ticket.ticket_type?.name) ?? "Ticket"
  const visibleId = nonEmpty(ticket.ticket_id) ?? ticketId(ticket)
  return `${type} #${visibleId}`
}

export function ticketPageContent(ticket: IntercomTicket): string {
  const description = htmlToPlainText(
    attributeText(ticket.ticket_attributes?._default_description_)
  )
  return description ? `## Description\n\n${escapeMarkdown(description)}` : ""
}

function lookupName(
  lookup: Map<string, string>,
  id: string | number | null | undefined,
  kind: "admin" | "team"
): string | undefined {
  if (id == null) return undefined
  const normalized = String(id).trim()
  if (!normalized || normalized === "0") return undefined
  return lookup.get(normalized) ?? `Unknown ${kind} (${normalized})`
}

function contactIds(ticket: IntercomTicket): string[] {
  return uniqueStrings(
    (ticket.contacts?.contacts ?? []).map((contact) => contact.id ?? undefined)
  )
}

export function ticketToChange(
  ticket: IntercomTicket,
  directory: AssignmentDirectory
): SyncChangeUpsert<typeof PRIMARY_KEY, typeof ticketSchema.properties> {
  const id = ticketId(ticket)
  const updated = unixSecondsToIso(ticket.updated_at, "Ticket updated_at")
  const created = unixSecondsToIso(ticket.created_at, "Ticket created_at")
  const state =
    nonEmpty(ticket.ticket_state?.internal_label) ??
    nonEmpty(ticket.ticket_state?.external_label)
  const stateCategory = nonEmpty(ticket.ticket_state?.category)
  const type = nonEmpty(ticket.ticket_type?.name)
  const category = nonEmpty(ticket.category)
  const assignee = lookupName(
    directory.admins,
    ticket.admin_assignee_id,
    "admin"
  )
  const team = lookupName(directory.teams, ticket.team_assignee_id, "team")
  const snoozedUntil = optionalUnixSecondsToIso(
    ticket.snoozed_until,
    "Ticket snoozed_until"
  )
  const inboxTicketId = nonEmpty(ticket.ticket_id)

  return {
    type: "upsert",
    key: id,
    upstreamUpdatedAt: updated,
    pageContentMarkdown: ticketPageContent(ticket),
    properties: {
      Title: Builder.title(ticketTitle(ticket)),
      State: state ? Builder.select(state) : [],
      "State Category": stateCategory
        ? Builder.select(humanize(stateCategory))
        : [],
      "Ticket Type": type ? Builder.select(type) : [],
      Category: category ? Builder.select(humanize(category)) : [],
      Contacts: contactIds(ticket).map((contactId) =>
        Builder.relation(contactId)
      ),
      Assignee: assignee ? Builder.richText(assignee) : [],
      Team: team ? Builder.richText(team) : [],
      Updated: Builder.dateTime(updated),
      Open: Builder.checkbox(ticket.open === true),
      "Snoozed Until": snoozedUntil ? Builder.dateTime(snoozedUntil) : [],
      "Shared with Customer": Builder.checkbox(ticket.is_shared === true),
      Created: Builder.dateTime(created),
      "Inbox Ticket ID": inboxTicketId ? Builder.richText(inboxTicketId) : [],
      "Ticket ID": Builder.richText(id),
    },
  }
}

function unixSeconds(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${label} must be a non-negative Unix timestamp in seconds.`
    )
  }
  return value
}

export function ticketIncrementalWindow(
  state: TicketIncrementalState | undefined,
  now: () => Date = () => new Date()
): { since: number; until: number } {
  const since = unixSeconds(
    state?.since ?? INITIAL_TICKET_WATERMARK,
    "Intercom ticket state.since"
  )
  if (state?.after && state.until === undefined) {
    throw new Error(
      "Intercom paginated ticket state is missing its pinned until."
    )
  }
  if (!state?.after && state?.until !== undefined) {
    throw new Error(
      "Intercom ticket state has until without a pagination cursor."
    )
  }
  validatedRecentCursors(state?.recentCursors)
  validatedPageCount(state?.pageCount)

  const nowSeconds = Math.floor(now().getTime() / 1_000)
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new Error("Intercom ticket sync clock is invalid.")
  }
  const until = unixSeconds(
    state?.until ??
      Math.max(since, nowSeconds - TICKET_CONSISTENCY_BUFFER_SECONDS),
    "Intercom ticket state.until"
  )
  if (until < since) {
    throw new Error("Intercom ticket sync window ends before it starts.")
  }
  return { since, until }
}

export function nextTicketWatermark(until: number): number {
  return Math.max(
    INITIAL_TICKET_WATERMARK,
    unixSeconds(until, "Intercom ticket watermark") -
      TICKET_WATERMARK_OVERLAP_SECONDS
  )
}

export async function runTicketIncrementalPage(
  client: IntercomClient,
  directory: AssignmentDirectory,
  state: TicketIncrementalState | undefined,
  now: () => Date = () => new Date()
) {
  const effectiveState =
    state?.after && state.lastRecordId === undefined
      ? { since: state.since }
      : state
  const { since, until } = ticketIncrementalWindow(effectiveState, now)
  const page = await client.searchTickets(since, until, effectiveState?.after)
  const recordIds = page.records.map(ticketId)
  const lastRecordId = lastAscendingRecordId(
    recordIds,
    effectiveState?.lastRecordId,
    "ticket search"
  )
  const changes = page.records.map((ticket) =>
    ticketToChange(ticket, directory)
  )

  if (page.nextCursor) {
    if (recordIds.length === 0 || lastRecordId === undefined) {
      throw new Error(
        "Intercom ticket search returned a cursor without records."
      )
    }
    return {
      changes,
      hasMore: true as const,
      nextState: {
        since,
        until,
        ...nextCursorState(effectiveState, page.nextCursor, "ticket search"),
        lastRecordId,
      },
    }
  }
  return {
    changes,
    hasMore: false as const,
    nextState: { since: nextTicketWatermark(until) },
  }
}

function expectedTicketCount(
  value: number | undefined,
  state: TicketReconciliationState | undefined
): number {
  if (!Number.isSafeInteger(value) || value == null || value < 0) {
    throw new Error(
      "Intercom ticket reconciliation has an invalid total_count."
    )
  }
  if (state && state.expectedTotalCount !== value) {
    throw new Error(
      "Intercom ticket total changed during replacement; retry the full sweep."
    )
  }
  return value
}

export async function runTicketReconciliationPage(
  client: IntercomClient,
  directory: AssignmentDirectory,
  state: TicketReconciliationState | undefined,
  now: () => Date = () => new Date()
) {
  // Deployments preserve continuation state. A run started before the pinned
  // membership or record-order guards existed safely restarts from page one;
  // keyed upserts make replay harmless and a complete restart preserves
  // replacement semantics.
  const effectiveState =
    state?.after &&
    (state.createdBefore == null || state.lastRecordId === undefined)
      ? undefined
      : state
  const nowSeconds = Math.floor(now().getTime() / 1_000)
  // Intercom documents its Ticket Search `<` operator as inclusive. Keep the
  // cutoff behind the same indexing buffer as incremental syncs so tickets
  // created during this stateless sweep cannot join its membership.
  const createdBefore = unixSeconds(
    effectiveState?.createdBefore ??
      Math.max(1, nowSeconds - TICKET_CONSISTENCY_BUFFER_SECONDS),
    "Intercom ticket reconciliation state.createdBefore"
  )
  if (createdBefore === 0) {
    throw new Error(
      "Intercom ticket reconciliation cutoff must be after the Unix epoch."
    )
  }
  const page = await client.searchTicketsForReconciliation(
    createdBefore,
    effectiveState?.after
  )
  const totalCount = expectedTicketCount(page.totalCount, effectiveState)
  const recentRecordIds = effectiveState?.recentRecordIds ?? []
  if (
    !Array.isArray(recentRecordIds) ||
    recentRecordIds.length > MAX_RECENT_TICKET_IDS ||
    recentRecordIds.some((id) => typeof id !== "string" || !id.trim())
  ) {
    throw new Error(
      "Intercom ticket reconciliation has invalid recent record state."
    )
  }
  const recordIds = page.records.map(ticketId)
  const lastRecordId = lastAscendingRecordId(
    recordIds,
    effectiveState?.lastRecordId,
    "ticket reconciliation"
  )
  const seenRecordIds = new Set(recentRecordIds)
  for (const id of recordIds) {
    if (seenRecordIds.has(id)) {
      throw new Error("Intercom ticket reconciliation repeated a record.")
    }
    seenRecordIds.add(id)
  }

  const changes = page.records.map((ticket) =>
    ticketToChange(ticket, directory)
  )
  const seenCount = (effectiveState?.seenCount ?? 0) + page.records.length
  if (seenCount > totalCount) {
    throw new Error(
      "Intercom ticket reconciliation returned more records than total_count."
    )
  }

  if (page.nextCursor) {
    if (recordIds.length === 0 || lastRecordId === undefined) {
      throw new Error(
        "Intercom ticket reconciliation returned a cursor without records."
      )
    }
    return {
      changes,
      hasMore: true as const,
      nextState: {
        ...nextCursorState(
          effectiveState,
          page.nextCursor,
          "ticket reconciliation"
        ),
        createdBefore,
        expectedTotalCount: totalCount,
        seenCount,
        lastRecordId,
        recentRecordIds: [...recentRecordIds, ...recordIds].slice(
          -MAX_RECENT_TICKET_IDS
        ),
      },
    }
  }
  if (seenCount !== totalCount) {
    throw new Error(
      "Intercom ticket replacement ended before total_count was reached."
    )
  }
  return { changes, hasMore: false as const }
}
