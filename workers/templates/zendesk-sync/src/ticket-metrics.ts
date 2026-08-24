// Ticket Metrics sync — tracks performance data per ticket (response times,
// resolution times, reopens, replies). Powers SLA compliance views and
// team performance dashboards.
//
// Time values use calendar minutes (not business hours). To use business
// hours instead, change the .calendar references to .business below.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import type { ZendeskTicketMetric } from "./zendesk.js"
import { dateOnly } from "./formatters.js"

export const INITIAL_TITLE = "Zendesk Ticket Metrics"
export const PRIMARY_KEY = "Ticket ID"

export const ticketMetricSchema = {
  databaseIcon: notionIcon("stopwatch"),
  properties: {
    "Ticket ID": Schema.title(),

    "Ticket Record": Schema.relation("tickets", {
      twoWay: true,
      relatedPropertyName: "Ticket Metrics",
    }),

    "First Reply (min)": Schema.number(),

    "Full Resolution (min)": Schema.number(),

    Reopens: Schema.number(),

    "Agents Touched": Schema.number(),

    "Groups Touched": Schema.number(),

    "Solved at": Schema.date(),

    "First Resolution (min)": Schema.number(),

    Replies: Schema.number(),

    "On Hold (min)": Schema.number(),

    "Agent Wait (min)": Schema.number(),

    "Requester Wait (min)": Schema.number(),

    "Updated at": Schema.date(),

    "Created at": Schema.date(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

function calendarMinutes(
  metric: ZendeskTicketMetric["reply_time_in_minutes"]
): number | null {
  return metric?.calendar ?? null
}

export function ticketMetricToChange(
  metric: ZendeskTicketMetric
): SyncChangeUpsert<typeof PRIMARY_KEY, typeof ticketMetricSchema.properties> {
  const firstReply = calendarMinutes(metric.reply_time_in_minutes)
  const firstResolution = calendarMinutes(
    metric.first_resolution_time_in_minutes
  )
  const fullResolution = calendarMinutes(metric.full_resolution_time_in_minutes)
  const agentWait = calendarMinutes(metric.agent_wait_time_in_minutes)
  const requesterWait = calendarMinutes(metric.requester_wait_time_in_minutes)
  const onHold = calendarMinutes(metric.on_hold_time_in_minutes)

  return {
    type: "upsert" as const,
    key: String(metric.ticket_id),
    ...(metric.updated_at ? { upstreamUpdatedAt: metric.updated_at } : {}),
    properties: {
      "Ticket ID": Builder.title(String(metric.ticket_id)),
      "Ticket Record": [Builder.relation(String(metric.ticket_id))],
      "First Reply (min)": firstReply != null ? Builder.number(firstReply) : [],
      "First Resolution (min)":
        firstResolution != null ? Builder.number(firstResolution) : [],
      "Full Resolution (min)":
        fullResolution != null ? Builder.number(fullResolution) : [],
      "Agent Wait (min)": agentWait != null ? Builder.number(agentWait) : [],
      "Requester Wait (min)":
        requesterWait != null ? Builder.number(requesterWait) : [],
      Reopens: metric.reopens != null ? Builder.number(metric.reopens) : [],
      "Agents Touched":
        metric.assignee_stations != null
          ? Builder.number(metric.assignee_stations)
          : [],
      "Groups Touched":
        metric.group_stations != null
          ? Builder.number(metric.group_stations)
          : [],
      "Solved at": metric.solved_at
        ? Builder.date(dateOnly(metric.solved_at))
        : [],
      Replies: metric.replies != null ? Builder.number(metric.replies) : [],
      "On Hold (min)": onHold != null ? Builder.number(onHold) : [],
      "Updated at": metric.updated_at
        ? Builder.date(dateOnly(metric.updated_at))
        : [],
      "Created at": metric.created_at
        ? Builder.date(dateOnly(metric.created_at))
        : [],
    },
  }
}
