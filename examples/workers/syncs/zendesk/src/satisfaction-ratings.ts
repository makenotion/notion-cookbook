// Satisfaction Ratings sync — tracks CSAT responses with customer comments.
// Requires Zendesk Professional+ plan (CSAT is a paid feature).
//
// Requester and assignee are stored as numeric IDs. Cross-reference with the
// Users sync for names, or extend fetchSatisfactionRatingsPage to sideload
// users if your Zendesk plan supports it.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import type { ZendeskSatisfactionRating } from "./zendesk.js"
import { dateOnly } from "./transform.js"

const SCORE_LABELS: Record<string, string> = {
  good: "Satisfied",
  bad: "Not satisfied",
  offered: "Pending",
}

export const INITIAL_TITLE = "Zendesk CSAT Ratings"
export const PRIMARY_KEY = "Rating ID"

export const satisfactionRatingSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  properties: {
    Comment: Schema.title(),

    "Rating ID": Schema.richText(),

    "Ticket ID": Schema.richText(),

    Score: Schema.select([
      { name: "Satisfied" },
      { name: "Not satisfied" },
      { name: "Pending" },
    ]),

    Reason: Schema.richText(),

    "Requester ID": Schema.richText(),

    "Assignee ID": Schema.richText(),

    "Created at": Schema.date(),
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
      ...(rating.reason
        ? { Reason: Builder.richText(rating.reason) }
        : {}),
      "Requester ID": Builder.richText(String(rating.requester_id)),
      "Assignee ID": Builder.richText(String(rating.assignee_id)),
      "Created at": Builder.date(dateOnly(rating.created_at)),
    },
  }
}
