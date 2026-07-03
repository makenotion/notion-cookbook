// CSAT Survey Responses sync — tracks feedback from Zendesk's current CSAT
// surveys. Available on Support Professional or Suite Growth and above.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import type { ZendeskSurveyAnswer, ZendeskSurveyResponse } from "./zendesk.js"
import { dateOnly, formatLabel } from "./formatters.js"

export const INITIAL_TITLE = "Zendesk CSAT Survey Responses"
export const PRIMARY_KEY = "Response ID"

export const surveyResponseSchema = {
  databaseIcon: notionIcon("thumbs-up"),
  properties: {
    Response: Schema.title(),

    Rating: Schema.number(),

    "Rating category": Schema.select([
      { name: "Good" },
      { name: "Neutral" },
      { name: "Bad" },
    ]),

    Feedback: Schema.richText(),

    Subject: Schema.richText(),

    "Ticket ID": Schema.richText(),

    "Ticket Record": Schema.relation("tickets", {
      twoWay: true,
      relatedPropertyName: "CSAT Responses",
    }),

    "Responder ID": Schema.richText(),

    "Responder Record": Schema.relation("users", {
      twoWay: true,
      relatedPropertyName: "CSAT Responses",
    }),

    "Survey ID": Schema.richText(),

    "Survey version": Schema.number(),

    "Survey state": Schema.select([{ name: "Enabled" }, { name: "Disabled" }]),

    "Updated at": Schema.date(),

    "Expires at": Schema.date(),

    "Response ID": Schema.richText(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

function latestAnswerUpdate(
  answers: ZendeskSurveyAnswer[]
): string | undefined {
  let latest: string | undefined
  for (const answer of answers) {
    const timestamp = answer.updated_at ?? answer.created_at
    if (timestamp && (!latest || timestamp > latest)) latest = timestamp
  }
  return latest
}

export function surveyResponseToChange(
  response: ZendeskSurveyResponse
): SyncChangeUpsert<
  typeof PRIMARY_KEY,
  typeof surveyResponseSchema.properties
> {
  const answers = response.answers ?? []
  const ratingAnswer = answers.find(
    (answer) =>
      answer.type === "rating_scale" &&
      answer.question.sub_type === "customer_satisfaction"
  )
  const feedback = answers
    .flatMap((answer) => {
      const value =
        answer.type === "open_ended" ? answer.value?.trim() : undefined
      return value ? [value] : []
    })
    .join("\n\n")
  const subject = response.subjects?.[0]
  const ticketId = response.subjects?.find(
    (candidate) => candidate.type === "ticket"
  )?.id
  const updatedAt = latestAnswerUpdate(answers)
  const title = ticketId
    ? `CSAT response for ticket ${ticketId}`
    : `CSAT response ${response.id}`

  return {
    type: "upsert" as const,
    key: response.id,
    ...(updatedAt ? { upstreamUpdatedAt: updatedAt } : {}),
    pageContentMarkdown: feedback,
    properties: {
      Response: Builder.title(title),
      "Response ID": Builder.richText(response.id),
      "Responder ID": Builder.richText(String(response.responder_id)),
      "Responder Record": [Builder.relation(String(response.responder_id))],
      Rating:
        ratingAnswer?.rating != null ? Builder.number(ratingAnswer.rating) : [],
      "Rating category": ratingAnswer?.rating_category
        ? Builder.select(formatLabel(ratingAnswer.rating_category))
        : [],
      Feedback: feedback ? Builder.richText(feedback) : [],
      Subject: subject ? Builder.richText(subject.zrn) : [],
      "Ticket ID": ticketId ? Builder.richText(ticketId) : [],
      "Ticket Record": ticketId ? [Builder.relation(ticketId)] : [],
      "Survey ID": response.survey?.id
        ? Builder.richText(response.survey.id)
        : [],
      "Survey version":
        response.survey?.version != null
          ? Builder.number(response.survey.version)
          : [],
      "Survey state": response.survey?.state
        ? Builder.select(formatLabel(response.survey.state))
        : [],
      "Updated at": updatedAt ? Builder.date(dateOnly(updatedAt)) : [],
      "Expires at": response.expires_at
        ? Builder.date(dateOnly(response.expires_at))
        : [],
    },
  }
}
