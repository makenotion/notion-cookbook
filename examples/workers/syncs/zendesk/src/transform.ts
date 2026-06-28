import * as Builder from "@notionhq/workers/builder"
import type { ZendeskTicket } from "./zendesk.js"

export function ticketToChange(ticket: ZendeskTicket, subdomain: string) {
  const csatScore = ticket.satisfaction_rating?.score
  const hasKnownCsat =
    csatScore === "good" || csatScore === "bad" || csatScore === "offered"

  return {
    type: "upsert" as const,
    key: String(ticket.id),
    upstreamUpdatedAt: ticket.updated_at,
    pageContentMarkdown: ticket.description ?? "",
    properties: {
      Tickets: Builder.title(ticket.subject ?? ""),
      "Ticket ID": Builder.richText(String(ticket.id)),
      "Ticket link": Builder.url(ticketUrl(subdomain, ticket.id)),
      ...(ticket.type
        ? { Type: Builder.select(capitalize(ticket.type)) }
        : {}),
      Status: Builder.select(capitalize(ticket.status ?? "new")),
      ...(ticket.priority
        ? { Priority: Builder.select(capitalize(ticket.priority)) }
        : {}),
      ...(hasKnownCsat
        ? { "CSAT score": Builder.select(capitalize(csatScore!)) }
        : {}),
      ...(ticket.tags.length > 0
        ? { "Feature tags": Builder.multiSelect(...ticket.tags) }
        : {}),
      Channel: Builder.select(capitalize(ticket.via?.channel ?? "web")),
      ...(ticket.assignee_id
        ? { "Assignee ID": Builder.richText(String(ticket.assignee_id)) }
        : {}),
      "Requester ID": Builder.richText(String(ticket.requester_id)),
      "Created at": Builder.date(dateOnly(ticket.created_at)),
    },
  }
}

export function ticketUrl(subdomain: string, ticketId: number): string {
  return `https://${subdomain}.zendesk.com/agent/tickets/${ticketId}`
}

function capitalize(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function dateOnly(value: string): string {
  if (!value) return ""
  if (value.includes("T")) return value.slice(0, 10)
  return value.slice(0, 10)
}
