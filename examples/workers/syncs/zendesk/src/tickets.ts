// Support Tickets schema and transform. Each Zendesk ticket becomes one page
// in the managed Notion database, with its description in the page body.
//
// IMPORTANT: Every schema property needs a matching Builder.* call in
// ticketToChange(), and vice versa.
//
// To add a new Zendesk ticket field:
//   1. Add the field to ZendeskTicket in zendesk.ts
//   2. Add a property here with the appropriate Schema type
//   3. Add a Builder.* call in ticketToChange() below
//
// Available Schema types:
//   Schema.title()            — page title (exactly one required)
//   Schema.richText()         — free-form text
//   Schema.number()           — numeric value
//   Schema.select([...])      — single-select; options auto-create if not listed
//   Schema.multiSelect([...]) — multi-select; options auto-create if not listed
//   Schema.date()             — date or datetime
//   Schema.url()              — URL link
//   Schema.email()            — email address
//   Schema.checkbox()         — boolean

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"
import type {
  ZendeskTicket,
  UserLookup,
  GroupLookup,
  OrgLookup,
} from "./zendesk.js"
import { dateOnly, formatLabel } from "./formatters.js"

export const INITIAL_TITLE =
  process.env.ZENDESK_SYNC_DB_TITLE ?? "Support Tickets"

// Ticket ID is the upsert key — the platform matches incoming changes against
// this property to decide whether to create or update a page.
export const PRIMARY_KEY = "Ticket ID"

export const ticketSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("ticket"),
  properties: {
    Subject: Schema.title(),

    Status: Schema.select([
      { name: "New" },
      { name: "Open" },
      { name: "Pending" },
      { name: "Hold" },
      { name: "Solved" },
      { name: "Closed" },
    ]),

    Priority: Schema.select([
      { name: "Urgent" },
      { name: "High" },
      { name: "Normal" },
      { name: "Low" },
    ]),

    Assignee: Schema.richText(),

    Group: Schema.richText(),

    "Ticket link": Schema.url(),

    "Updated at": Schema.date(),

    Requester: Schema.richText(),

    Organization: Schema.richText(),

    Type: Schema.select([
      { name: "Problem" },
      { name: "Incident" },
      { name: "Question" },
      { name: "Task" },
    ]),

    // Common channels are seeded below. If your Zendesk uses additional
    // channels (e.g. "Mobile SDK"), the select option is created automatically.
    Channel: Schema.select([
      { name: "Web" },
      { name: "Email" },
      { name: "Chat" },
      { name: "API" },
      { name: "Mobile" },
    ]),

    // Options are created automatically from your Zendesk tags — no need to
    // list them here. Add seed values if you want them pre-created.
    Tags: Schema.multiSelect([]),

    "Created at": Schema.date(),

    "Ticket ID": Schema.richText(),
  },
}

// Use explicit labels when Zendesk's raw values need product-specific casing.
const CHANNEL_LABELS: Record<string, string> = {
  web: "Web",
  email: "Email",
  chat: "Chat",
  api: "API",
  mobile: "Mobile",
}

// Nullable fields are omitted instead of writing empty values into Notion.
export function ticketToChange(
  ticket: ZendeskTicket,
  subdomain: string,
  users: UserLookup,
  groups: GroupLookup,
  orgs: OrgLookup
) {
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
      "Created at": Builder.date(dateOnly(ticket.created_at)),
      "Ticket ID": Builder.richText(String(ticket.id)),
    },
  }
}

export function ticketUrl(subdomain: string, ticketId: number): string {
  return `https://${subdomain}.zendesk.com/agent/tickets/${ticketId}`
}
