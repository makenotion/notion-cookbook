// CSAT Survey Responses sync — tracks feedback from Zendesk's current CSAT
// surveys. Available on Support Professional or Suite Growth and above.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"
import type { ZendeskSurveyAnswer, ZendeskSurveyResponse } from "./zendesk.js"
import { dateOnly, formatLabel } from "./formatters.js"

export const INITIAL_TITLE = "Zendesk CSAT Survey Responses"
export const PRIMARY_KEY = "Response ID"

export const surveyResponseSchema: Schema.Schema<typeof PRIMARY_KEY> = {
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

    "Responder ID": Schema.richText(),

    "Survey ID": Schema.richText(),

    "Survey version": Schema.number(),

    "Survey state": Schema.select([{ name: "Enabled" }, { name: "Disabled" }]),

    "Updated at": Schema.date(),

    "Expires at": Schema.date(),

    "Response ID": Schema.richText(),
  },
}

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

export function surveyResponseToChange(response: ZendeskSurveyResponse) {
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
    ...(feedback ? { pageContentMarkdown: feedback } : {}),
    properties: {
      Response: Builder.title(title),
      "Response ID": Builder.richText(response.id),
      "Responder ID": Builder.richText(String(response.responder_id)),
      ...(ratingAnswer?.rating != null
        ? { Rating: Builder.number(ratingAnswer.rating) }
        : {}),
      ...(ratingAnswer?.rating_category
        ? {
            "Rating category": Builder.select(
              formatLabel(ratingAnswer.rating_category)
            ),
          }
        : {}),
      ...(feedback ? { Feedback: Builder.richText(feedback) } : {}),
      ...(subject ? { Subject: Builder.richText(subject.zrn) } : {}),
      ...(ticketId ? { "Ticket ID": Builder.richText(ticketId) } : {}),
      ...(response.survey?.id
        ? { "Survey ID": Builder.richText(response.survey.id) }
        : {}),
      ...(response.survey?.version != null
        ? { "Survey version": Builder.number(response.survey.version) }
        : {}),
      ...(response.survey?.state
        ? {
            "Survey state": Builder.select(formatLabel(response.survey.state)),
          }
        : {}),
      ...(updatedAt ? { "Updated at": Builder.date(dateOnly(updatedAt)) } : {}),
      ...(response.expires_at
        ? { "Expires at": Builder.date(dateOnly(response.expires_at)) }
        : {}),
    },
  }
}
