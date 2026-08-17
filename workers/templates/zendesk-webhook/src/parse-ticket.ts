import type {
  ZendeskComment,
  ZendeskTicket,
  ZendeskUser,
} from "./zendesk/types.js"

function asString(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  return ""
}

// Webhook payloads prefix description with a dashed separator block; drop it.
function stripWebhookDescriptionPrefix(description: string): string {
  const parts = description.split("\n\n")
  if (parts.length <= 1) return description.trim()
  return parts.slice(1).join("\n\n").trim()
}

function formatCommentSection(header: string, body: string): string {
  return header ? `--- ${header} ---\n${body}` : body
}

function formatTicketDescriptionHeader(
  author: string,
  createdAt: string
): string {
  const parts: string[] = []
  const trimmedAuthor = author.trim()
  if (trimmedAuthor) parts.push(trimmedAuthor)

  const trimmedCreatedAt = createdAt.trim()
  if (trimmedCreatedAt) {
    const parsed = Date.parse(trimmedCreatedAt)
    if (!Number.isNaN(parsed)) {
      parts.push(new Date(parsed).toISOString())
    }
  }

  return parts.join(" · ")
}

// Wraps a plain Search API ticket body to match comment sections.
// Leaves descriptions that are already formatted unchanged (webhook path).
function formatPlainTicketDescription(
  body: string,
  options: { author: string; createdAt: string }
): string {
  const trimmed = body.trim()
  if (!trimmed) return ""
  if (trimmed.startsWith("---")) return trimmed

  const header = formatTicketDescriptionHeader(
    options.author,
    options.createdAt
  )
  return formatCommentSection(header, trimmed)
}

function formatWebhookCommentHeader(
  headerLine: string,
  createdAt: string
): string {
  const author = headerLine.includes(",")
    ? headerLine.split(",")[0].trim()
    : headerLine.trim()
  return formatTicketDescriptionHeader(author, createdAt)
}

// Formats a webhook ticket description to match comment sections:
// --- Author · ISO timestamp ---\nbody
function formatWebhookDescription(
  description: string,
  createdAt: string
): string {
  const stripped = stripWebhookDescriptionPrefix(description)
  if (!stripped) return ""

  const parts = stripped.split("\n\n")
  if (parts.length <= 1) return stripped

  const headerLine = parts[0].trim()
  const body = parts.slice(1).join("\n\n").trim()
  if (!body) return stripped

  const header = formatWebhookCommentHeader(headerLine, createdAt)
  return formatCommentSection(header, body)
}

export function normalizeTicketRecord(
  record: Record<string, unknown>
): ZendeskTicket | null {
  const ticketId = asString(record.ticket_id) || asString(record.id)
  const subject = asString(record.subject)
  if (!ticketId || !subject) return null

  return {
    ticketId,
    ticketUrl: asString(record.ticket_url),
    email: asString(record.email),
    subject,
    description: asString(record.description),
    assignee: asString(record.assignee),
    status: asString(record.status),
    latestComment: asString(record.latest_comment),
    createdAt: asString(record.created_at),
  }
}

function parseNormalizedWebhookTicket(
  record: Record<string, unknown>
): ZendeskTicket | null {
  const ticket = normalizeTicketRecord(record)
  if (!ticket) return null
  return {
    ...ticket,
    description: formatWebhookDescription(ticket.description, ticket.createdAt),
  }
}

// Extracts ticket fields from a Zendesk webhook body.
// Supports a flat payload or a nested `ticket` object.
export function parseZendeskTicket(
  body: Record<string, unknown>
): ZendeskTicket | null {
  const direct = parseNormalizedWebhookTicket(body)
  if (direct) return direct

  const nested = body.ticket
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return parseNormalizedWebhookTicket(nested as Record<string, unknown>)
  }

  return null
}

function commentBody(comment: ZendeskComment): string {
  const plain = comment.plain_body?.trim()
  if (plain) return plain
  return comment.body?.trim() ?? ""
}

function formatCommentHeader(
  comment: ZendeskComment,
  usersById: Map<number, string>
): string {
  const parts: string[] = []
  if (comment.author_id != null) {
    const name = usersById.get(comment.author_id)
    if (name) parts.push(name)
  }
  if (comment.created_at) {
    const parsed = Date.parse(comment.created_at)
    if (!Number.isNaN(parsed)) {
      parts.push(new Date(parsed).toISOString())
    }
  }
  if (comment.public === false) parts.push("internal")
  return parts.join(" · ")
}

// Builds the Notion Description value: ticket body, then each comment.
// Skips the first Zendesk comment — it is always the ticket description.
export function formatDescriptionWithComments(
  description: string,
  comments: ZendeskComment[],
  users: ZendeskUser[] = [],
  options: { author: string; createdAt: string } = { author: "", createdAt: "" }
): string {
  const usersById = new Map<number, string>()
  for (const user of users) {
    if (typeof user.id === "number" && user.name) {
      usersById.set(user.id, user.name)
    }
  }

  const sections: string[] = []
  const formattedBody = formatPlainTicketDescription(description, options)
  if (formattedBody) sections.push(formattedBody)

  const threadComments = comments.slice(1)
  for (const comment of threadComments) {
    if (comment.type && comment.type !== "Comment") continue
    const body = commentBody(comment)
    if (!body) continue

    const header = formatCommentHeader(comment, usersById)
    sections.push(formatCommentSection(header, body))
  }

  return sections.join("\n\n")
}

// Returns a copy of the ticket with Description set from comments.
export function withDescriptionFromComments(
  ticket: ZendeskTicket,
  comments: ZendeskComment[],
  users: ZendeskUser[] = []
): ZendeskTicket {
  return {
    ...ticket,
    description: formatDescriptionWithComments(
      ticket.description,
      comments,
      users,
      {
        author: ticket.email || ticket.assignee,
        createdAt: ticket.createdAt,
      }
    ),
  }
}
