import * as Schema from "@notionhq/workers/schema"

export const INITIAL_TITLE =
  process.env.ZENDESK_SYNC_DB_TITLE ?? "Support Tickets"

export const PRIMARY_KEY = "Ticket ID"

export const ticketSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  properties: {
    Tickets: Schema.title(),

    "Ticket ID": Schema.richText(),

    "Ticket link": Schema.url(),

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

    "CSAT score": Schema.select([
      { name: "Good" },
      { name: "Bad" },
      { name: "Offered" },
    ]),

    "Feature tags": Schema.multiSelect([
      { name: "Account access" },
      { name: "Billing" },
      { name: "Bug report" },
      { name: "Feature request" },
      { name: "Integration" },
    ]),

    "Created at": Schema.date(),
  },
}
