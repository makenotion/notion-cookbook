// Organizations sync — tracks the companies in your Zendesk instance.
// Useful for B2B support teams to see accounts, domains, and tags in Notion.
//
// Schema and transform follow the same pattern as tickets — see schema.ts
// and transform.ts for the conventions.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"
import type { ZendeskOrganization } from "./zendesk.js"
import { dateOnly } from "./transform.js"

export const INITIAL_TITLE = "Zendesk Organizations"
export const PRIMARY_KEY = "Org ID"

export const organizationSchema: Schema.Schema<typeof PRIMARY_KEY> = {
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
}

export function organizationToChange(org: ZendeskOrganization) {
  return {
    type: "upsert" as const,
    key: String(org.id),
    upstreamUpdatedAt: org.updated_at,
    pageContentMarkdown: org.notes ?? "",
    properties: {
      Name: Builder.title(org.name ?? ""),
      "Org ID": Builder.richText(String(org.id)),
      ...(org.domain_names.length > 0
        ? { Domains: Builder.richText(org.domain_names.join(", ")) }
        : {}),
      ...(org.tags.length > 0
        ? { Tags: Builder.multiSelect(...org.tags) }
        : {}),
      ...(org.details
        ? { Details: Builder.richText(org.details) }
        : {}),
      "Created at": Builder.date(dateOnly(org.created_at)),
      "Updated at": Builder.date(dateOnly(org.updated_at)),
    },
  }
}
