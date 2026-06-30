// Ticket Metrics sync — tracks performance data per ticket (response times,
// resolution times, reopens, replies). Powers SLA compliance views and
// team performance dashboards.
//
// Time values use calendar minutes (not business hours). To use business
// hours instead, change the .calendar references to .business below.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"
import type { ZendeskTicketMetric } from "./zendesk.js"
import { dateOnly } from "./formatters.js"

export const INITIAL_TITLE = "Zendesk Ticket Metrics"
export const PRIMARY_KEY = "Ticket ID"

export const ticketMetricSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("stopwatch"),
  properties: {
    "Ticket ID": Schema.title(),

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
}

function calendarMinutes(
  metric: ZendeskTicketMetric["reply_time_in_minutes"]
): number | null {
  return metric?.calendar ?? null
}

export function ticketMetricToChange(metric: ZendeskTicketMetric) {
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
      ...(firstReply != null
        ? { "First Reply (min)": Builder.number(firstReply) }
        : {}),
      ...(firstResolution != null
        ? { "First Resolution (min)": Builder.number(firstResolution) }
        : {}),
      ...(fullResolution != null
        ? { "Full Resolution (min)": Builder.number(fullResolution) }
        : {}),
      ...(agentWait != null
        ? { "Agent Wait (min)": Builder.number(agentWait) }
        : {}),
      ...(requesterWait != null
        ? { "Requester Wait (min)": Builder.number(requesterWait) }
        : {}),
      ...(metric.reopens != null
        ? { Reopens: Builder.number(metric.reopens) }
        : {}),
      ...(metric.assignee_stations != null
        ? { "Agents Touched": Builder.number(metric.assignee_stations) }
        : {}),
      ...(metric.group_stations != null
        ? { "Groups Touched": Builder.number(metric.group_stations) }
        : {}),
      ...(metric.solved_at
        ? { "Solved at": Builder.date(dateOnly(metric.solved_at)) }
        : {}),
      ...(metric.replies != null
        ? { Replies: Builder.number(metric.replies) }
        : {}),
      ...(onHold != null ? { "On Hold (min)": Builder.number(onHold) } : {}),
      ...(metric.updated_at
        ? { "Updated at": Builder.date(dateOnly(metric.updated_at)) }
        : {}),
      ...(metric.created_at
        ? { "Created at": Builder.date(dateOnly(metric.created_at)) }
        : {}),
    },
  }
}
