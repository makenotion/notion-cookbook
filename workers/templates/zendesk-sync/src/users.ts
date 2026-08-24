// Users sync — tracks agents and end-users in your Zendesk instance.
// Creates an agent roster for workload planning, or an end-user directory
// showing your most active requesters.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import type { ZendeskFullUser } from "./zendesk.js"
import { formatLabel, dateOnly } from "./formatters.js"

export const INITIAL_TITLE = "Zendesk Users"
export const PRIMARY_KEY = "User ID"

export const userSchema = {
  databaseIcon: notionIcon("people"),
  properties: {
    Name: Schema.title(),

    Role: Schema.select([
      { name: "End-user" },
      { name: "Agent" },
      { name: "Admin" },
    ]),

    Email: Schema.email(),

    "Last login": Schema.date(),

    Tags: Schema.multiSelect([]),

    "Updated at": Schema.date(),

    "Organization ID": Schema.richText(),

    "Organization Record": Schema.relation("organizations", {
      twoWay: true,
      relatedPropertyName: "Users",
    }),

    Phone: Schema.richText(),

    Suspended: Schema.checkbox(),

    "User ID": Schema.richText(),

    "Created at": Schema.date(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

const ROLE_LABELS: Record<string, string> = {
  "end-user": "End-user",
  agent: "Agent",
  admin: "Admin",
}

export function userToChange(
  user: ZendeskFullUser
): SyncChangeUpsert<typeof PRIMARY_KEY, typeof userSchema.properties> {
  return {
    type: "upsert" as const,
    key: String(user.id),
    upstreamUpdatedAt: user.updated_at,
    properties: {
      Name: Builder.title(user.name ?? ""),
      "User ID": Builder.richText(String(user.id)),
      Email: user.email ? Builder.email(user.email) : [],
      Role: Builder.select(
        ROLE_LABELS[user.role] ?? formatLabel(user.role ?? "end-user")
      ),
      "Organization ID":
        user.organization_id != null
          ? Builder.richText(String(user.organization_id))
          : [],
      "Organization Record":
        user.organization_id != null
          ? [Builder.relation(String(user.organization_id))]
          : [],
      Phone: user.phone ? Builder.richText(user.phone) : [],
      Tags: user.tags.length > 0 ? Builder.multiSelect(...user.tags) : [],
      Suspended: Builder.checkbox(user.suspended),
      "Last login": user.last_login_at
        ? Builder.date(dateOnly(user.last_login_at))
        : [],
      "Created at": Builder.date(dateOnly(user.created_at)),
      "Updated at": Builder.date(dateOnly(user.updated_at)),
    },
  }
}
