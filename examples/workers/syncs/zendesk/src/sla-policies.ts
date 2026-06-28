// SLA Policies sync — a reference table of your SLA definitions with targets
// flattened into columns for at-a-glance comparison.
// Requires Zendesk Professional+ plan.
//
// This is a small, rarely-changing dataset (typically <20 policies), so
// it uses a manual schedule and fetches everything in one call.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"
import type { ZendeskSlaPolicy, ZendeskSlaPolicyMetric } from "./zendesk.js"
import { dateOnly } from "./transform.js"

export const INITIAL_TITLE = "Zendesk SLA Policies"
export const PRIMARY_KEY = "Policy ID"

export const slaPolicySchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("shield"),
  properties: {
    Title: Schema.title(),

    "Urgent First Reply (min)": Schema.number(),

    "High First Reply (min)": Schema.number(),

    "Normal First Reply (min)": Schema.number(),

    "Low First Reply (min)": Schema.number(),

    Position: Schema.number(),

    "Urgent Resolution (min)": Schema.number(),

    "High Resolution (min)": Schema.number(),

    "Normal Resolution (min)": Schema.number(),

    "Low Resolution (min)": Schema.number(),

    "Policy ID": Schema.richText(),

    "Updated at": Schema.date(),

    "Created at": Schema.date(),
  },
}

function findTarget(
  metrics: ZendeskSlaPolicyMetric[],
  metric: string,
  priority: string
): number | undefined {
  const match = metrics.find(
    (m) => m.metric === metric && m.priority === priority
  )
  return match?.target
}

export function slaPolicyToChange(policy: ZendeskSlaPolicy) {
  const metrics = policy.policy_metrics ?? []
  const description = policy.description ?? ""

  const urgentReply = findTarget(metrics, "first_reply_time", "urgent")
  const highReply = findTarget(metrics, "first_reply_time", "high")
  const normalReply = findTarget(metrics, "first_reply_time", "normal")
  const lowReply = findTarget(metrics, "first_reply_time", "low")

  const urgentRes = findTarget(metrics, "total_resolution_time", "urgent")
  const highRes = findTarget(metrics, "total_resolution_time", "high")
  const normalRes = findTarget(metrics, "total_resolution_time", "normal")
  const lowRes = findTarget(metrics, "total_resolution_time", "low")

  return {
    type: "upsert" as const,
    key: String(policy.id),
    upstreamUpdatedAt: policy.updated_at,
    pageContentMarkdown: description,
    properties: {
      Title: Builder.title(policy.title ?? ""),
      "Policy ID": Builder.richText(String(policy.id)),
      Position: Builder.number(policy.position),
      ...(urgentReply != null
        ? { "Urgent First Reply (min)": Builder.number(urgentReply) }
        : {}),
      ...(highReply != null
        ? { "High First Reply (min)": Builder.number(highReply) }
        : {}),
      ...(normalReply != null
        ? { "Normal First Reply (min)": Builder.number(normalReply) }
        : {}),
      ...(lowReply != null
        ? { "Low First Reply (min)": Builder.number(lowReply) }
        : {}),
      ...(urgentRes != null
        ? { "Urgent Resolution (min)": Builder.number(urgentRes) }
        : {}),
      ...(highRes != null
        ? { "High Resolution (min)": Builder.number(highRes) }
        : {}),
      ...(normalRes != null
        ? { "Normal Resolution (min)": Builder.number(normalRes) }
        : {}),
      ...(lowRes != null
        ? { "Low Resolution (min)": Builder.number(lowRes) }
        : {}),
      "Created at": Builder.date(dateOnly(policy.created_at)),
      "Updated at": Builder.date(dateOnly(policy.updated_at)),
    },
  }
}
