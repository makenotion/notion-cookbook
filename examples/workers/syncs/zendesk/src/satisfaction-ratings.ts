// Legacy Satisfaction Ratings sync — tracks responses from Zendesk's legacy
// CSAT feature. Accounts using current CSAT surveys need the Survey Responses API.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"
import type { ZendeskSatisfactionRating } from "./zendesk.js"
import { dateOnly } from "./transform.js"

const SCORE_LABELS: Record<string, string> = {
  good: "Satisfied",
  bad: "Not satisfied",
  offered: "Pending",
}

export const INITIAL_TITLE = "Zendesk Legacy CSAT Ratings"
export const PRIMARY_KEY = "Rating ID"

export const satisfactionRatingSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("thumbs-up"),
  properties: {
    Comment: Schema.title(),

    Score: Schema.select([
      { name: "Satisfied" },
      { name: "Not satisfied" },
      { name: "Pending" },
    ]),

    "Ticket ID": Schema.richText(),

    Reason: Schema.richText(),

    "Created at": Schema.date(),

    "Rating ID": Schema.richText(),
  },
}

export function satisfactionRatingToChange(rating: ZendeskSatisfactionRating) {
  const scoreLabel = SCORE_LABELS[rating.score] ?? rating.score

  return {
    type: "upsert" as const,
    key: String(rating.id),
    upstreamUpdatedAt: rating.updated_at,
    properties: {
      Comment: Builder.title(rating.comment ?? "(no comment)"),
      "Rating ID": Builder.richText(String(rating.id)),
      "Ticket ID": Builder.richText(String(rating.ticket_id)),
      Score: Builder.select(scoreLabel),
      ...(rating.reason ? { Reason: Builder.richText(rating.reason) } : {}),
      "Created at": Builder.date(dateOnly(rating.created_at)),
    },
  }
}
