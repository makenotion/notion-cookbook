import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

import {
  type AssignmentDirectory,
  type IntercomClient,
  type IntercomConversation,
} from "./intercom.js"
import {
  escapeMarkdown,
  htmlToPlainText,
  humanize,
  nonEmpty,
  optionalUnixSecondsToIso,
  secondsToMinutes,
  uniqueStrings,
  unixSecondsToIso,
} from "./helpers.js"
import {
  nextCursorState,
  validatedPageCount,
  validatedRecentCursors,
  type CursorSyncState,
} from "./pagination.js"

export const INITIAL_TITLE = "Intercom Conversations"
export const PRIMARY_KEY = "Conversation ID"

export const conversationSchema = {
  databaseIcon: notionIcon("chat"),
  properties: {
    Title: Schema.title(),

    State: Schema.select([
      { name: "Open" },
      { name: "Closed" },
      { name: "Snoozed" },
    ]),

    Priority: Schema.checkbox(),

    Unread: Schema.checkbox(),

    Contacts: Schema.relation("contacts", {
      twoWay: true,
      relatedPropertyName: "Conversations",
    }),

    Assignee: Schema.richText(),

    Team: Schema.richText(),

    Updated: Schema.date(),

    "Waiting Since": Schema.date(),

    Channel: Schema.select([]),

    Tags: Schema.multiSelect([]),

    "SLA Status": Schema.select([
      { name: "Active" },
      { name: "Hit" },
      { name: "Missed" },
      { name: "Cancelled" },
    ]),

    Rating: Schema.number(),

    Company: Schema.relation("companies", {
      twoWay: true,
      relatedPropertyName: "Conversations",
    }),

    "First Reply (min)": Schema.number(),

    "Median Reply (min)": Schema.number(),

    "Handling Time (min)": Schema.number(),

    "Last Contact Reply": Schema.date(),

    Reopens: Schema.number(),

    "AI Resolution": Schema.select([
      { name: "Assumed Resolution" },
      { name: "Confirmed Resolution" },
      { name: "Escalated" },
      { name: "Negative Feedback" },
      { name: "Procedure Handoff" },
    ]),

    "Snoozed Until": Schema.date(),

    Created: Schema.date(),

    "Conversation ID": Schema.richText(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

const CHANNEL_NAMES: Record<string, string> = {
  conversation: "Messenger",
  email: "Email",
  facebook: "Facebook",
  instagram: "Instagram",
  phone_call: "Phone call",
  phone_switch: "Phone switch",
  push: "Push",
  sms: "SMS",
  twitter: "Twitter",
  whatsapp: "WhatsApp",
}

function boundedTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized.length > 200
    ? `${normalized.slice(0, 197).trimEnd()}...`
    : normalized
}

function conversationId(conversation: IntercomConversation): string {
  const id = nonEmpty(conversation.id)
  if (!id) throw new Error("Intercom conversation is missing its id.")
  return id
}

export function conversationTitle(conversation: IntercomConversation): string {
  const title = nonEmpty(conversation.title)
  if (title) return boundedTitle(title)

  const subject = nonEmpty(conversation.source?.subject)
  if (subject) return boundedTitle(subject)

  if (!conversation.source?.redacted) {
    const body = htmlToPlainText(conversation.source?.body)
    if (body) return boundedTitle(body)
  }

  return `Conversation ${conversationId(conversation)}`
}

export function conversationPageContent(
  conversation: IntercomConversation
): string {
  const sections: string[] = []

  if (conversation.source?.redacted) {
    sections.push(
      "## Opening message\n\n_This opening message was redacted in Intercom._"
    )
  } else {
    const body = htmlToPlainText(conversation.source?.body)
    if (body) sections.push(`## Opening message\n\n${escapeMarkdown(body)}`)
  }

  const ratingRemark = nonEmpty(conversation.conversation_rating?.remark)
  if (ratingRemark) {
    sections.push(
      `## Customer rating comment\n\n${escapeMarkdown(ratingRemark)}`
    )
  }

  return sections.join("\n\n")
}

function contactIds(conversation: IntercomConversation): string[] {
  return uniqueStrings(
    (conversation.contacts?.contacts ?? []).map(
      (contact) => contact.id ?? undefined
    )
  )
}

function lookupName(
  lookup: Map<string, string>,
  id: string | number | null | undefined,
  kind: "admin" | "team"
): string | undefined {
  if (id == null) return undefined
  const normalized = String(id).trim()
  if (!normalized || normalized === "0") return undefined
  return lookup.get(normalized) ?? `Unknown ${kind} (${normalized})`
}

function channelName(value: string | null | undefined): string | undefined {
  const channel = nonEmpty(value)
  return channel ? (CHANNEL_NAMES[channel] ?? humanize(channel)) : undefined
}

function tagNames(conversation: IntercomConversation): string[] {
  return uniqueStrings(
    (conversation.tags?.tags ?? []).map((tag) => {
      const id = nonEmpty(tag.id)
      return nonEmpty(tag.name) ?? (id ? `Unknown tag (${id})` : undefined)
    })
  )
}

function finiteNumber(value: number | null | undefined): number | undefined {
  return value != null && Number.isFinite(value) ? value : undefined
}

export function conversationToChange(
  conversation: IntercomConversation,
  directory: AssignmentDirectory
): SyncChangeUpsert<typeof PRIMARY_KEY, typeof conversationSchema.properties> {
  const id = conversationId(conversation)
  const updated = unixSecondsToIso(
    conversation.updated_at,
    "Conversation updated_at"
  )
  const created = unixSecondsToIso(
    conversation.created_at,
    "Conversation created_at"
  )
  const state = nonEmpty(conversation.state)
  const contacts = contactIds(conversation)
  const assignee = lookupName(
    directory.admins,
    conversation.admin_assignee_id,
    "admin"
  )
  const team = lookupName(
    directory.teams,
    conversation.team_assignee_id,
    "team"
  )
  const waitingSince = optionalUnixSecondsToIso(
    conversation.waiting_since,
    "Conversation waiting_since"
  )
  const channel = channelName(conversation.source?.type)
  const tags = tagNames(conversation)
  const slaStatus = nonEmpty(conversation.sla_applied?.sla_status)
  const rating = finiteNumber(conversation.conversation_rating?.rating)
  const companyId = nonEmpty(conversation.company?.id)
  const firstReplyMinutes = secondsToMinutes(
    conversation.statistics?.time_to_admin_reply
  )
  const medianReplyMinutes = secondsToMinutes(
    conversation.statistics?.median_time_to_reply
  )
  const handlingTimeMinutes = secondsToMinutes(
    conversation.statistics?.adjusted_handling_time ??
      conversation.statistics?.handling_time
  )
  const lastContactReply = optionalUnixSecondsToIso(
    conversation.statistics?.last_contact_reply_at,
    "Conversation statistics.last_contact_reply_at"
  )
  const reopens = finiteNumber(conversation.statistics?.count_reopens)
  const aiResolution = nonEmpty(conversation.ai_agent?.resolution_state)
  const snoozedUntil = optionalUnixSecondsToIso(
    conversation.snoozed_until,
    "Conversation snoozed_until"
  )

  return {
    type: "upsert",
    key: id,
    upstreamUpdatedAt: updated,
    pageContentMarkdown: conversationPageContent(conversation),
    properties: {
      Title: Builder.title(conversationTitle(conversation)),
      State: state ? Builder.select(humanize(state)) : [],
      Priority: Builder.checkbox(conversation.priority === "priority"),
      Unread: Builder.checkbox(conversation.read === false),
      Contacts: contacts.map((contactId) => Builder.relation(contactId)),
      Assignee: assignee ? Builder.richText(assignee) : [],
      Team: team ? Builder.richText(team) : [],
      Updated: Builder.dateTime(updated),
      "Waiting Since": waitingSince ? Builder.dateTime(waitingSince) : [],
      Channel: channel ? Builder.select(channel) : [],
      Tags: tags.length > 0 ? Builder.multiSelect(...tags) : [],
      "SLA Status": slaStatus ? Builder.select(humanize(slaStatus)) : [],
      Rating: rating !== undefined ? Builder.number(rating) : [],
      Company: companyId ? [Builder.relation(companyId)] : [],
      "First Reply (min)":
        firstReplyMinutes !== undefined
          ? Builder.number(firstReplyMinutes)
          : [],
      "Median Reply (min)":
        medianReplyMinutes !== undefined
          ? Builder.number(medianReplyMinutes)
          : [],
      "Handling Time (min)":
        handlingTimeMinutes !== undefined
          ? Builder.number(handlingTimeMinutes)
          : [],
      "Last Contact Reply": lastContactReply
        ? Builder.dateTime(lastContactReply)
        : [],
      Reopens: reopens !== undefined ? Builder.number(reopens) : [],
      "AI Resolution": aiResolution
        ? Builder.select(humanize(aiResolution))
        : [],
      "Snoozed Until": snoozedUntil ? Builder.dateTime(snoozedUntil) : [],
      Created: Builder.dateTime(created),
      "Conversation ID": Builder.richText(id),
    },
  }
}

export type ConversationIncrementalState = {
  since: number
  until?: number
  after?: string
  recentCursors?: string[]
  pageCount?: number
}

export const INITIAL_CONVERSATION_WATERMARK = 0
export const CONSISTENCY_BUFFER_SECONDS = 60
export const WATERMARK_OVERLAP_SECONDS = 5 * 60

function unixSeconds(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${label} must be a non-negative Unix timestamp in seconds.`
    )
  }
  return value
}

export function conversationIncrementalWindow(
  state: ConversationIncrementalState | undefined,
  now: () => Date = () => new Date()
): { since: number; until: number } {
  const since = unixSeconds(
    state?.since ?? INITIAL_CONVERSATION_WATERMARK,
    "Intercom conversation state.since"
  )

  if (state?.after && state.until === undefined) {
    throw new Error(
      "Intercom paginated conversation state is missing its pinned until."
    )
  }
  if (!state?.after && state?.until !== undefined) {
    throw new Error(
      "Intercom conversation state has until without a pagination cursor."
    )
  }
  validatedRecentCursors(state?.recentCursors)
  validatedPageCount(state?.pageCount)

  const nowSeconds = Math.floor(now().getTime() / 1_000)
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new Error("Intercom conversation sync clock is invalid.")
  }
  const until = unixSeconds(
    state?.until ?? Math.max(since, nowSeconds - CONSISTENCY_BUFFER_SECONDS),
    "Intercom conversation state.until"
  )
  if (until < since) {
    throw new Error("Intercom conversation sync window ends before it starts.")
  }
  return { since, until }
}

export function nextConversationWatermark(until: number): number {
  return Math.max(
    INITIAL_CONVERSATION_WATERMARK,
    unixSeconds(until, "Intercom conversation watermark") -
      WATERMARK_OVERLAP_SECONDS
  )
}

export async function runConversationIncrementalPage(
  client: IntercomClient,
  directory: AssignmentDirectory,
  state: ConversationIncrementalState | undefined,
  now: () => Date = () => new Date()
) {
  const { since, until } = conversationIncrementalWindow(state, now)
  const page = await client.searchConversations(since, until, state?.after)
  const changes = page.records.map((conversation) =>
    conversationToChange(conversation, directory)
  )

  if (page.nextCursor) {
    return {
      changes,
      hasMore: true as const,
      nextState: {
        since,
        until,
        ...nextCursorState(state, page.nextCursor, "conversation search"),
      },
    }
  }

  return {
    changes,
    hasMore: false as const,
    nextState: { since: nextConversationWatermark(until) },
  }
}

export async function runConversationReconciliationPage(
  client: IntercomClient,
  directory: AssignmentDirectory,
  state: CursorSyncState | undefined
) {
  const page = await client.listConversations(state?.after)
  const changes = page.records.map((conversation) =>
    conversationToChange(conversation, directory)
  )

  if (page.nextCursor) {
    return {
      changes,
      hasMore: true as const,
      nextState: nextCursorState(
        state,
        page.nextCursor,
        "conversation reconciliation"
      ),
    }
  }
  return { changes, hasMore: false as const }
}
