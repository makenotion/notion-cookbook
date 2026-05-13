import * as Builder from "@notionhq/workers/builder"
import type { ZdTicket } from "./types.js"

// Zendesk's incremental endpoint streams BOTH live tickets and tombstones
// for soft-deleted ones (status === "deleted"). The change record type
// flips accordingly so Notion mirrors the delete.
export function ticketToChange(ticket: ZdTicket) {
  const key = String(ticket.id)

  if (ticket.status === "deleted") {
    return { type: "delete" as const, key }
  }

  return {
    type: "upsert" as const,
    key,
    properties: {
      Subject: Builder.title(ticket.subject || "(no subject)"),
      "Ticket ID": Builder.richText(key),
      URL: Builder.url(agentUrl(ticket.id)),
      Status: Builder.richText(ticket.status),
      Priority: Builder.richText(ticket.priority ?? ""),
      "Requester ID": Builder.richText(
        ticket.requester_id != null ? String(ticket.requester_id) : ""
      ),
      "Assignee ID": Builder.richText(
        ticket.assignee_id != null ? String(ticket.assignee_id) : ""
      ),
      Tags: Builder.richText(ticket.tags.join(", ")),
      Updated: Builder.dateTime(ticket.updated_at),

      // Example: read a custom field by id. Uncomment, swap in your
      // field id, and add a matching `Schema.richText()` entry to
      // the database schema in `index.ts`.
      //
      // "Account Tier": Builder.richText(
      //     String(
      //         ticket.custom_fields.find((f) => f.id === 360001234567)
      //             ?.value ?? "",
      //     ),
      // ),
    },
  }
}

// Agent-facing URL — the API `url` field points to the JSON endpoint, not
// the human-readable ticket page.
function agentUrl(ticketId: number): string {
  const subdomain = process.env.ZENDESK_SUBDOMAIN ?? ""
  return `https://${subdomain}.zendesk.com/agent/tickets/${ticketId}`
}
