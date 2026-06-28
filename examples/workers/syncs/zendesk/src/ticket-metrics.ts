// Ticket Metrics sync — tracks performance data per ticket (response times,
// resolution times, reopens, replies). Powers SLA compliance views and
// team performance dashboards.
//
// Time values use calendar minutes (not business hours). To use business
// hours instead, change the .calendar references to .business below.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import type { ZendeskTicketMetric } from "./zendesk.js"
import { dateOnly } from "./transform.js"

export const INITIAL_TITLE = "Zendesk Ticket Metrics"
export const PRIMARY_KEY = "Ticket ID"

export const ticketMetricSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  properties: {
    "Ticket ID": Schema.title(),

    "First Reply (min)": Schema.number(),

    "First Resolution (min)": Schema.number(),

    "Full Resolution (min)": Schema.number(),

    "Agent Wait (min)": Schema.number(),

    "Requester Wait (min)": Schema.number(),

    Reopens: Schema.number(),

    Replies: Schema.number(),

    "Created at": Schema.date(),

    "Updated at": Schema.date(),
  },
}

export function ticketMetricToChange(metric: ZendeskTicketMetric) {
  return {
    type: "upsert" as const,
    key: String(metric.ticket_id),
    upstreamUpdatedAt: metric.updated_at,
    properties: {
      "Ticket ID": Builder.title(String(metric.ticket_id)),
      "First Reply (min)": Builder.number(
        metric.reply_time_in_minutes.calendar
      ),
      "First Resolution (min)": Builder.number(
        metric.first_resolution_time_in_minutes.calendar
      ),
      "Full Resolution (min)": Builder.number(
        metric.full_resolution_time_in_minutes.calendar
      ),
      "Agent Wait (min)": Builder.number(
        metric.agent_wait_time_in_minutes.calendar
      ),
      "Requester Wait (min)": Builder.number(
        metric.requester_wait_time_in_minutes.calendar
      ),
      Reopens: Builder.number(metric.reopens),
      Replies: Builder.number(metric.replies),
      "Created at": Builder.date(dateOnly(metric.created_at)),
      "Updated at": Builder.date(dateOnly(metric.updated_at)),
    },
  }
}
