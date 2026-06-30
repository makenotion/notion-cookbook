import { withDescriptionFromComments } from "../parse-ticket.js"
import {
  isAllowedZendeskApiUrl,
  requireZendeskAuthorization,
  resolveZendeskSubdomain,
  zendeskApiBaseUrl,
} from "./config.js"
import { zendeskFetchJson } from "./client.js"
import { zendeskApiStatusToNotionStatus } from "./status.js"
import { fetchZendeskTicket } from "./ticket.js"
import type {
  ListCommentsResponse,
  ZendeskComment,
  ZendeskTicket,
  ZendeskUser,
} from "./types.js"

// Lists all comments on a ticket (paginated), with users sideloaded for author names.
export async function fetchAllTicketComments(
  ticketId: string,
  options: { ticketUrl?: string; subdomain?: string } = {}
): Promise<{ comments: ZendeskComment[]; users: ZendeskUser[] }> {
  const subdomain =
    options.subdomain ?? resolveZendeskSubdomain(options.ticketUrl ?? "")
  const base = zendeskApiBaseUrl(subdomain)
  let url = `${base}/tickets/${ticketId}/comments?sort_order=asc&include=users`

  const comments: ZendeskComment[] = []
  const usersById = new Map<number, ZendeskUser>()

  while (url) {
    const page = await zendeskFetchJson<ListCommentsResponse>(
      url,
      "Zendesk list comments failed",
      subdomain
    )
    if (page.comments?.length) comments.push(...page.comments)
    for (const user of page.users ?? []) {
      if (typeof user.id === "number") usersById.set(user.id, user)
    }
    const rawNextPage =
      typeof page.next_page === "string" ? page.next_page.trim() : ""
    if (rawNextPage && !isAllowedZendeskApiUrl(rawNextPage, subdomain)) {
      console.warn(
        `[fetchAllTicketComments] Ignoring untrusted Zendesk next_page URL for ticket ${ticketId}`
      )
      url = ""
    } else {
      url = rawNextPage
    }
  }

  return { comments, users: [...usersById.values()] }
}

// Fetches ticket comments and canonical status from Zendesk and returns an
// enriched copy. On failure, logs and returns the original ticket unchanged.
export async function enrichTicketWithComments(
  ticket: ZendeskTicket,
  logPrefix: string
): Promise<ZendeskTicket> {
  // Zendesk API credentials are required to fetch comments.
  requireZendeskAuthorization()

  try {
    const subdomain = resolveZendeskSubdomain(ticket.ticketUrl)
    const [{ comments, users }, apiTicket] = await Promise.all([
      fetchAllTicketComments(ticket.ticketId, {
        ticketUrl: ticket.ticketUrl,
        subdomain,
      }),
      fetchZendeskTicket(ticket.ticketId, {
        ticketUrl: ticket.ticketUrl,
        subdomain,
      }),
    ])
    console.log(
      `[${logPrefix}] Fetched ${comments.length} comment(s) for ticket ${ticket.ticketId}`
    )

    let enriched = withDescriptionFromComments(ticket, comments, users)

    const notionStatus = zendeskApiStatusToNotionStatus(apiTicket.status)
    if (notionStatus) {
      enriched = { ...enriched, status: notionStatus }
    } else {
      console.warn(
        `[${logPrefix}] Unmapped Zendesk API status "${apiTicket.status}" for ticket ${ticket.ticketId}; keeping webhook value "${ticket.status}"`
      )
    }

    return enriched
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(
      `[${logPrefix}] Zendesk enrichment failed for ticket ${ticket.ticketId}: ${message}`
    )
    return ticket
  }
}
