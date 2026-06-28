// Schema defines the Notion database structure. Each property here becomes a
// column in the managed database.
//
// IMPORTANT: This file and transform.ts must stay in sync. Every property name
// here needs a matching Builder.* call in ticketToChange(), and vice versa.
//
// To add a new Zendesk field:
//   1. Add the field to ZendeskTicket in zendesk.ts
//   2. Add a property here with the appropriate Schema type
//   3. Add a Builder.* call in transform.ts
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
import { notionIcon } from "@notionhq/workers"

export const INITIAL_TITLE =
  process.env.ZENDESK_SYNC_DB_TITLE ?? "Support Tickets"

// Ticket ID is the upsert key — the platform matches incoming changes against
// this property to decide whether to create or update a page. The `key` field
// in each change (see transform.ts) must contain the value for this property.
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

    "CSAT score": Schema.select([
      { name: "Satisfied" },
      { name: "Not satisfied" },
      { name: "Pending" },
    ]),

    "Created at": Schema.date(),

    "Ticket ID": Schema.richText(),
  },
}
