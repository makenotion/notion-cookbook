import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

import { directoryKey } from "./keys.js"
import { normalizedWorkEmail } from "./validation.js"

export const INITIAL_TITLE = "Workday People"
export const PRIMARY_KEY = "Directory Key"
export const MAX_MANAGER_RELATIONS = 100

export type DirectoryOrganizationReference = {
  workdayWid: string
  name: string
}

export type DirectoryPerson = {
  workdayWid: string
  name: string
  workEmail?: string
  supervisoryOrganization: DirectoryOrganizationReference
  managerWorkdayWids: string[]
}

export const peopleSchema = {
  databaseIcon: notionIcon("people"),
  properties: {
    Name: Schema.title(),

    "Work Email": Schema.email(),

    "Notion Profile": Schema.people(),

    "Supervisory Organization": Schema.relation("organizations", {
      twoWay: true,
      relatedPropertyName: "Organization Members",
    }),

    "Supervisory Managers": Schema.relation("people", {
      twoWay: true,
      relatedPropertyName: "Direct Reports",
    }),

    "Directory Key": Schema.richText(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

export function personToChange(
  person: DirectoryPerson
): SyncChangeUpsert<typeof PRIMARY_KEY, typeof peopleSchema.properties> {
  const personKey = directoryKey("person", person.workdayWid)
  const workEmail = person.workEmail
    ? normalizedWorkEmail(person.workEmail, "Workday public primary work email")
    : undefined
  const managerKeys = [
    ...new Set(
      person.managerWorkdayWids
        .map((wid) => directoryKey("person", wid))
        .filter((key) => key !== personKey)
    ),
  ].sort()

  if (managerKeys.length > MAX_MANAGER_RELATIONS) {
    throw new Error(
      `Workday employee has more than ${MAX_MANAGER_RELATIONS} manager relations.`
    )
  }

  return {
    type: "upsert",
    key: personKey,
    properties: {
      Name: Builder.title(person.name),
      "Work Email": workEmail ? Builder.email(workEmail) : [],
      "Notion Profile": workEmail ? Builder.people(workEmail) : [],
      "Supervisory Organization": [
        Builder.relation(
          directoryKey(
            "organization",
            person.supervisoryOrganization.workdayWid
          )
        ),
      ],
      "Supervisory Managers": managerKeys.map((key) => Builder.relation(key)),
      "Directory Key": Builder.richText(personKey),
    },
  }
}
