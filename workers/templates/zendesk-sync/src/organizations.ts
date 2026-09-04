// Organizations sync — tracks the companies in your Zendesk instance.
// Useful for B2B support teams to see accounts, domains, and tags in Notion.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import type { ZendeskOrganization } from "./zendesk.js"
import { dateOnly } from "./formatters.js"

export const INITIAL_TITLE = "Zendesk Organizations"
export const PRIMARY_KEY = "Org ID"

export const organizationSchema = {
  databaseIcon: notionIcon("briefcase"),
  properties: {
    Name: Schema.title(),

    Domains: Schema.richText(),

    Tags: Schema.multiSelect([]),

    Details: Schema.richText(),

    "Updated at": Schema.date(),

    "Org ID": Schema.richText(),

    "Created at": Schema.date(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

export function organizationToChange(
  org: ZendeskOrganization
): SyncChangeUpsert<typeof PRIMARY_KEY, typeof organizationSchema.properties> {
  return {
    type: "upsert" as const,
    key: String(org.id),
    upstreamUpdatedAt: org.updated_at,
    pageContentMarkdown: org.notes ?? "",
    properties: {
      Name: Builder.title(org.name ?? ""),
      "Org ID": Builder.richText(String(org.id)),
      Domains:
        org.domain_names.length > 0
          ? Builder.richText(org.domain_names.join(", "))
          : [],
      Tags: org.tags.length > 0 ? Builder.multiSelect(...org.tags) : [],
      Details: org.details ? Builder.richText(org.details) : [],
      "Created at": Builder.date(dateOnly(org.created_at)),
      "Updated at": Builder.date(dateOnly(org.updated_at)),
    },
  }
}
