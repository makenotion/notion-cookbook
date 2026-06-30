// Notion database property names — edit these to match your database schema.
// Names are case-sensitive and must match exactly what appears in Notion.
export const SUBJECT_PROPERTY = "Subject"
export const TICKET_ID_PROPERTY = "Zendesk Ticket ID"
export const TICKET_URL_PROPERTY = "URL"
export const REQUESTER_PROPERTY = "Requester"
export const STATUS_PROPERTY = "Status"

// Status option names — must match the Status property options in your Notion database.
export const ZENDESK_STATUSES = [
  "New",
  "Open",
  "Pending",
  "On-hold",
  "Solved",
  "Closed",
] as const

export const ASSIGNEE_PROPERTY = "Assignee"
export const DESCRIPTION_PROPERTY = "Description"
export const LATEST_COMMENT_PROPERTY = "Latest comment"
export const CREATED_AT_PROPERTY = "Created at"

export const NOTION_RICH_TEXT_CHUNK_SIZE = 2000
