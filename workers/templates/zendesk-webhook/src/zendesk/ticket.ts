import { resolveZendeskSubdomain, zendeskApiBaseUrl } from "./config.js"
import { zendeskFetchJson } from "./client.js"
import type { ShowTicketResponse } from "./types.js"

// Fetches a ticket from the Zendesk REST API. Status is returned as a
// locale-independent key (e.g. "hold"), not the agent UI label.
export async function fetchZendeskTicket(
  ticketId: string,
  options: { ticketUrl?: string; subdomain?: string } = {}
): Promise<ShowTicketResponse["ticket"]> {
  const subdomain =
    options.subdomain ?? resolveZendeskSubdomain(options.ticketUrl ?? "")
  const base = zendeskApiBaseUrl(subdomain)
  const url = `${base}/tickets/${ticketId}.json`

  const response = await zendeskFetchJson<ShowTicketResponse>(
    url,
    "Zendesk show ticket failed",
    subdomain
  )
  return response.ticket
}
