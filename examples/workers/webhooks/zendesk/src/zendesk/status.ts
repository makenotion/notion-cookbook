import { ZENDESK_STATUSES } from "../constants.js"

export type ZendeskStatus = (typeof ZENDESK_STATUSES)[number]

// Zendesk REST API ticket.status values (locale-independent).
const ZENDESK_API_STATUS_TO_NOTION: Record<string, ZendeskStatus> = {
  new: "New",
  open: "Open",
  pending: "Pending",
  hold: "On-hold",
  solved: "Solved",
  closed: "Closed",
}

export function isZendeskStatus(value: string): value is ZendeskStatus {
  const name = value.trim()
  return (ZENDESK_STATUSES as readonly string[]).includes(name)
}

// Maps a Zendesk API status key (e.g. "hold") to the Notion Status option name.
export function zendeskApiStatusToNotionStatus(
  apiStatus: string
): ZendeskStatus | undefined {
  const key = apiStatus.trim().toLowerCase()
  const mapped = ZENDESK_API_STATUS_TO_NOTION[key]
  if (mapped) return mapped

  const trimmed = apiStatus.trim()
  return isZendeskStatus(trimmed) ? trimmed : undefined
}

export function notionApiStatusProperty(
  status: string
): { status: { name: string } } | undefined {
  const canonical = zendeskApiStatusToNotionStatus(status)
  if (!canonical) {
    if (!status.trim()) return undefined
    throw new Error(
      `Unsupported Zendesk status "${status}". Expected one of: ${ZENDESK_STATUSES.join(", ")}.`
    )
  }
  return { status: { name: canonical } }
}
