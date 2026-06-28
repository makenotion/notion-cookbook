// Users sync — tracks agents and end-users in your Zendesk instance.
// Creates an agent roster for workload planning, or an end-user directory
// showing your most active requesters.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import type { ZendeskFullUser } from "./zendesk.js"
import { formatLabel, dateOnly } from "./transform.js"

export const INITIAL_TITLE = "Zendesk Users"
export const PRIMARY_KEY = "User ID"

export const userSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  properties: {
    Name: Schema.title(),

    "User ID": Schema.richText(),

    Email: Schema.email(),

    Role: Schema.select([
      { name: "End-user" },
      { name: "Agent" },
      { name: "Admin" },
    ]),

    Phone: Schema.richText(),

    Tags: Schema.multiSelect([]),

    Suspended: Schema.checkbox(),

    "Last login": Schema.date(),

    "Created at": Schema.date(),

    "Updated at": Schema.date(),
  },
}

export function userToChange(user: ZendeskFullUser) {
  return {
    type: "upsert" as const,
    key: String(user.id),
    upstreamUpdatedAt: user.updated_at,
    properties: {
      Name: Builder.title(user.name ?? ""),
      "User ID": Builder.richText(String(user.id)),
      ...(user.email ? { Email: Builder.email(user.email) } : {}),
      Role: Builder.select(formatLabel(user.role ?? "end-user")),
      ...(user.phone ? { Phone: Builder.richText(user.phone) } : {}),
      ...(user.tags.length > 0
        ? { Tags: Builder.multiSelect(...user.tags) }
        : {}),
      Suspended: Builder.checkbox(user.suspended),
      ...(user.last_login_at
        ? { "Last login": Builder.date(dateOnly(user.last_login_at)) }
        : {}),
      "Created at": Builder.date(dateOnly(user.created_at)),
      "Updated at": Builder.date(dateOnly(user.updated_at)),
    },
  }
}
