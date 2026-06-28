// SLA Policies sync — a reference table of your SLA definitions.
// Requires Zendesk Professional+ plan.
//
// This is a small, rarely-changing dataset (typically <20 policies), so
// it uses a manual schedule and fetches everything in one call.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import type { ZendeskSlaPolicy, ZendeskSlaPolicyMetric } from "./zendesk.js"
import { dateOnly } from "./transform.js"

export const INITIAL_TITLE = "Zendesk SLA Policies"
export const PRIMARY_KEY = "Policy ID"

export const slaPolicySchema: Schema.Schema<typeof PRIMARY_KEY> = {
  properties: {
    Title: Schema.title(),

    "Policy ID": Schema.richText(),

    Position: Schema.number(),

    "Created at": Schema.date(),

    "Updated at": Schema.date(),
  },
}

// Formats the policy_metrics array into a readable markdown table for the
// page body, so users can see the SLA targets at a glance.
function formatPolicyMetrics(metrics: ZendeskSlaPolicyMetric[]): string {
  if (!metrics.length) return ""

  const lines = [
    "| Priority | Metric | Target (min) | Business hours |",
    "| --- | --- | --- | --- |",
  ]

  for (const m of metrics) {
    lines.push(
      `| ${m.priority} | ${m.metric} | ${m.target} | ${m.business_hours ? "Yes" : "No"} |`
    )
  }

  return lines.join("\n")
}

export function slaPolicyToChange(policy: ZendeskSlaPolicy) {
  const description = policy.description ?? ""
  const metricsTable = formatPolicyMetrics(policy.policy_metrics ?? [])
  const body = [description, metricsTable].filter(Boolean).join("\n\n")

  return {
    type: "upsert" as const,
    key: String(policy.id),
    upstreamUpdatedAt: policy.updated_at,
    pageContentMarkdown: body,
    properties: {
      Title: Builder.title(policy.title ?? ""),
      "Policy ID": Builder.richText(String(policy.id)),
      Position: Builder.number(policy.position),
      "Created at": Builder.date(dateOnly(policy.created_at)),
      "Updated at": Builder.date(dateOnly(policy.updated_at)),
    },
  }
}
