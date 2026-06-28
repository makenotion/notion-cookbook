// Transform maps each Zendesk ticket to a sync change that the platform
// applies to the managed Notion database.
//
// IMPORTANT: Property names here must exactly match the keys in schema.ts.
// If you add, rename, or remove a property in schema.ts, update this file too.
//
// Nullable fields use conditional spread: ...(value ? { Prop: Builder.x(value) } : {})
// This omits the property entirely when the source field is null, rather than
// writing an empty value. Omitting is preferred — it keeps the Notion database
// clean and avoids overwriting user edits with blanks.

import * as Builder from "@notionhq/workers/builder"
import type { ZendeskTicket, UserLookup, GroupLookup, OrgLookup } from "./zendesk.js"

// Use explicit label maps when Zendesk's raw values don't match what users
// expect to see in Notion. For values not in the map, formatLabel() is used
// as a fallback (replaces underscores with spaces and title-cases each word).

const CSAT_LABELS: Record<string, string> = {
  good: "Satisfied",
  bad: "Not satisfied",
  offered: "Pending",
}

const CHANNEL_LABELS: Record<string, string> = {
  web: "Web",
  email: "Email",
  chat: "Chat",
  api: "API",
  mobile: "Mobile",
}

export function ticketToChange(
  ticket: ZendeskTicket,
  subdomain: string,
  users: UserLookup,
  groups: GroupLookup,
  orgs: OrgLookup
) {
  const csatLabel = CSAT_LABELS[ticket.satisfaction_rating?.score ?? ""]

  const assigneeName = ticket.assignee_id
    ? users.get(ticket.assignee_id)?.name ?? String(ticket.assignee_id)
    : null
  const requesterName =
    users.get(ticket.requester_id)?.name ?? String(ticket.requester_id)
  const groupName = ticket.group_id
    ? groups.get(ticket.group_id)?.name ?? String(ticket.group_id)
    : null
  const orgName = ticket.organization_id
    ? orgs.get(ticket.organization_id)?.name ?? null
    : null

  return {
    type: "upsert" as const,
    key: String(ticket.id),
    upstreamUpdatedAt: ticket.updated_at,
    pageContentMarkdown: ticket.description ?? "",
    properties: {
      Subject: Builder.title(ticket.subject ?? ""),
      Status: Builder.select(formatLabel(ticket.status ?? "new")),
      ...(ticket.priority
        ? { Priority: Builder.select(formatLabel(ticket.priority)) }
        : {}),
      ...(assigneeName ? { Assignee: Builder.richText(assigneeName) } : {}),
      ...(groupName ? { Group: Builder.richText(groupName) } : {}),
      "Ticket link": Builder.url(ticketUrl(subdomain, ticket.id)),
      "Updated at": Builder.date(dateOnly(ticket.updated_at)),
      Requester: Builder.richText(requesterName),
      ...(orgName ? { Organization: Builder.richText(orgName) } : {}),
      ...(ticket.type
        ? { Type: Builder.select(formatLabel(ticket.type)) }
        : {}),
      Channel: Builder.select(
        CHANNEL_LABELS[ticket.via?.channel ?? "web"] ??
          formatLabel(ticket.via?.channel ?? "web")
      ),
      ...(ticket.tags.length > 0
        ? { Tags: Builder.multiSelect(...ticket.tags) }
        : {}),
      ...(csatLabel ? { "CSAT score": Builder.select(csatLabel) } : {}),
      "Created at": Builder.date(dateOnly(ticket.created_at)),
      "Ticket ID": Builder.richText(String(ticket.id)),
    },
  }
}

export function ticketUrl(subdomain: string, ticketId: number): string {
  return `https://${subdomain}.zendesk.com/agent/tickets/${ticketId}`
}

// Converts Zendesk API values (e.g. "mobile_sdk") to display labels
// (e.g. "Mobile Sdk"). Use CHANNEL_LABELS or CSAT_LABELS instead when the
// raw value needs a specific mapping (e.g. "api" → "API", not "Api").
export function formatLabel(s: string): string {
  if (!s) return s
  return s
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

export function dateOnly(value: string): string {
  if (!value) return ""
  if (value.includes("T")) return value.slice(0, 10)
  return value.slice(0, 10)
}
