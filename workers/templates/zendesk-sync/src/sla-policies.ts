// SLA Policies sync — a reference table of your SLA definitions with targets
// flattened into columns for at-a-glance comparison.
// Requires Support Professional or Suite Growth and above.
//
// This is a small, rarely-changing dataset, so it refreshes daily and follows
// Zendesk's offset pages before completing each replace sweep.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import type { ZendeskSlaPolicy, ZendeskSlaPolicyMetric } from "./zendesk.js"
import { dateOnly } from "./formatters.js"

export const INITIAL_TITLE = "Zendesk SLA Policies"
export const PRIMARY_KEY = "Policy ID"

export const slaPolicySchema = {
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
} satisfies Schema.Schema<typeof PRIMARY_KEY>

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

export function slaPolicyToChange(
  policy: ZendeskSlaPolicy
): SyncChangeUpsert<typeof PRIMARY_KEY, typeof slaPolicySchema.properties> {
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
    ...(policy.updated_at ? { upstreamUpdatedAt: policy.updated_at } : {}),
    pageContentMarkdown: description,
    properties: {
      Title: Builder.title(policy.title ?? ""),
      "Policy ID": Builder.richText(String(policy.id)),
      Position: policy.position != null ? Builder.number(policy.position) : [],
      "Urgent First Reply (min)":
        urgentReply != null ? Builder.number(urgentReply) : [],
      "High First Reply (min)":
        highReply != null ? Builder.number(highReply) : [],
      "Normal First Reply (min)":
        normalReply != null ? Builder.number(normalReply) : [],
      "Low First Reply (min)": lowReply != null ? Builder.number(lowReply) : [],
      "Urgent Resolution (min)":
        urgentRes != null ? Builder.number(urgentRes) : [],
      "High Resolution (min)": highRes != null ? Builder.number(highRes) : [],
      "Normal Resolution (min)":
        normalRes != null ? Builder.number(normalRes) : [],
      "Low Resolution (min)": lowRes != null ? Builder.number(lowRes) : [],
      "Created at": policy.created_at
        ? Builder.date(dateOnly(policy.created_at))
        : [],
      "Updated at": policy.updated_at
        ? Builder.date(dateOnly(policy.updated_at))
        : [],
    },
  }
}
