import type { Client } from "@notionhq/client"
import {
  ASSIGNEE_PROPERTY,
  CREATED_AT_PROPERTY,
  DESCRIPTION_PROPERTY,
  LATEST_COMMENT_PROPERTY,
  NOTION_RICH_TEXT_CHUNK_SIZE,
  REQUESTER_PROPERTY,
  STATUS_PROPERTY,
  SUBJECT_PROPERTY,
  TICKET_ID_PROPERTY,
  TICKET_URL_PROPERTY,
} from "./constants.js"
import type { ZendeskTicket } from "./zendesk/types.js"
import { notionApiStatusProperty } from "./zendesk/status.js"

const NOTION_APPEND_BLOCK_BATCH_SIZE = 100

// Regexes for parsing Notion page/database IDs from URLs or plain strings.
const HYPHENATED_UUID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const BARE_UUID = /[0-9a-f]{32}/i

export function getNotionDatabaseId(): string {
  const databaseId = process.env.ZENDESK_NOTION_DATABASE_ID?.trim()
  if (!databaseId) {
    throw new Error(
      "ZENDESK_NOTION_DATABASE_ID is not set. Set it in your environment (e.g. a local .env or via your platform's secrets)."
    )
  }
  return databaseId
}

// Accept a UUID (hyphenated or bare 32-char hex) or a Notion database URL and
// return the bare 32-char ID. Notion database URLs end with a title slug whose
// tail is the 32-char id, e.g.
// https://notion.so/My-DB-550e8400e29b41d4a716446655440000 — so pull the id
// out of the last path segment rather than expecting the whole segment to be one.
export function normalizeNotionDatabaseId(input: string): string {
  let segment = input.trim()
  try {
    segment =
      new URL(segment).pathname.split("/").filter(Boolean).pop() ?? segment
  } catch {
    // not a URL — use the value as-is
  }

  const hyphenated = segment.match(HYPHENATED_UUID)
  if (hyphenated) return hyphenated[0].replace(/-/g, "")

  const bare = segment.match(BARE_UUID)
  if (bare) return bare[0].toLowerCase()

  throw new Error(
    `Invalid Notion database ID or URL: "${input}". Provide a 32-char id or a Notion database URL.`
  )
}

function richTextChunks(content: string): Array<{ text: { content: string } }> {
  if (!content) return []
  const chunks: Array<{ text: { content: string } }> = []
  for (let i = 0; i < content.length; i += NOTION_RICH_TEXT_CHUNK_SIZE) {
    chunks.push({
      text: { content: content.slice(i, i + NOTION_RICH_TEXT_CHUNK_SIZE) },
    })
  }
  return chunks
}

function blockRichText(content: string): Array<{
  type: "text"
  text: { content: string }
}> {
  return richTextChunks(content).map((chunk) => ({
    type: "text" as const,
    text: chunk.text,
  }))
}

type DescriptionParagraphBlock = {
  object: "block"
  type: "paragraph"
  paragraph: {
    rich_text: ReturnType<typeof blockRichText>
  }
}

function descriptionToParagraphBlocks(
  description: string
): DescriptionParagraphBlock[] {
  const trimmed = description.trim()
  if (!trimmed) return []

  return trimmed.split(/\n\n+/).map((paragraph) => ({
    object: "block" as const,
    type: "paragraph" as const,
    paragraph: { rich_text: blockRichText(paragraph) },
  }))
}

async function clearPageBlockChildren(
  notion: Client,
  pageId: string
): Promise<void> {
  let cursor: string | undefined

  do {
    const response = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    })

    for (const block of response.results) {
      if (!("id" in block) || typeof block.id !== "string") continue
      await notion.blocks.delete({ block_id: block.id })
    }

    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
  } while (cursor)
}

async function syncTicketDescriptionBlocks(
  notion: Client,
  pageId: string,
  description: string
): Promise<void> {
  await clearPageBlockChildren(notion, pageId)

  const children = descriptionToParagraphBlocks(description)
  if (children.length === 0) return

  for (let i = 0; i < children.length; i += NOTION_APPEND_BLOCK_BATCH_SIZE) {
    const batch = children.slice(i, i + NOTION_APPEND_BLOCK_BATCH_SIZE)
    await notion.blocks.children.append({
      block_id: pageId,
      children: batch as never,
    })
  }
}

function richTextProperty(content: string) {
  return { rich_text: richTextChunks(content) }
}

function titleProperty(content: string) {
  return { title: richTextChunks(content) }
}

function urlProperty(url: string) {
  if (!url) return undefined
  return { url }
}

function dateProperty(isoDate: string) {
  const trimmed = isoDate.trim()
  if (!trimmed) return undefined
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) return undefined
  return { date: { start: new Date(parsed).toISOString() } }
}

function statusProperty(status: string) {
  return notionApiStatusProperty(status)
}

function buildTicketProperties(ticket: ZendeskTicket): Record<string, unknown> {
  const properties: Record<string, unknown> = {}

  if (ticket.subject) {
    properties[SUBJECT_PROPERTY] = richTextProperty(ticket.subject)
  }
  if (ticket.ticketId) {
    properties[TICKET_ID_PROPERTY] = titleProperty(ticket.ticketId)
  }
  if (ticket.ticketUrl) {
    properties[TICKET_URL_PROPERTY] = urlProperty(ticket.ticketUrl)
  }
  if (ticket.email) {
    properties[REQUESTER_PROPERTY] = richTextProperty(ticket.email)
  }
  if (ticket.status) {
    const status = statusProperty(ticket.status)
    if (status) properties[STATUS_PROPERTY] = status
  }
  if (ticket.assignee) {
    properties[ASSIGNEE_PROPERTY] = richTextProperty(ticket.assignee)
  }
  if (ticket.description) {
    properties[DESCRIPTION_PROPERTY] = richTextProperty(ticket.description)
  }
  if (ticket.latestComment) {
    properties[LATEST_COMMENT_PROPERTY] = richTextProperty(ticket.latestComment)
  }
  if (ticket.createdAt) {
    const createdAt = dateProperty(ticket.createdAt)
    if (createdAt) properties[CREATED_AT_PROPERTY] = createdAt
  }

  return properties
}

async function findPageByTicketId(
  notion: Client,
  databaseId: string,
  ticketId: string
): Promise<string | null> {
  const response = await notion.databases.query({
    database_id: databaseId,
    filter: {
      property: TICKET_ID_PROPERTY,
      title: { equals: ticketId },
    },
    page_size: 1,
  })

  const page = response.results[0]
  if (page && "id" in page && typeof page.id === "string") {
    return page.id
  }
  return null
}

export type UpsertTicketResult = {
  action: "created" | "updated"
  pageId: string
}

export async function upsertZendeskTicket(
  notion: Client,
  databaseId: string,
  ticket: ZendeskTicket
): Promise<UpsertTicketResult> {
  const normalizedDatabaseId = normalizeNotionDatabaseId(databaseId)
  const properties = buildTicketProperties(ticket)

  if (!ticket.ticketId) {
    throw new Error(
      "Zendesk ticket id is required to upsert a Notion page (Zendesk Ticket ID property)."
    )
  }

  let pageId: string
  let action: UpsertTicketResult["action"]

  const existingPageId = await findPageByTicketId(
    notion,
    normalizedDatabaseId,
    ticket.ticketId
  )

  if (existingPageId) {
    await notion.pages.update({
      page_id: existingPageId,
      properties: properties as never,
    })
    pageId = existingPageId
    action = "updated"
  } else {
    const created = await notion.pages.create({
      parent: { database_id: normalizedDatabaseId },
      properties: properties as never,
    })
    pageId = typeof created.id === "string" ? created.id : ""
    if (!pageId) {
      throw new Error("Notion page create succeeded but returned no page id.")
    }
    action = "created"
  }

  await syncTicketDescriptionBlocks(notion, pageId, ticket.description)
  return { action, pageId }
}
