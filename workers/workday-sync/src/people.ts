import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

import { directoryKey } from "./keys.js"

export const INITIAL_TITLE = "Workday People"
export const PRIMARY_KEY = "Directory Key"

export type DirectoryTeamReference = {
  workdayWid: string
  name: string
}

export type DirectoryPerson = {
  workdayWid: string
  name: string
  team: DirectoryTeamReference
  managerWorkdayWids: string[]
}

export const peopleSchema = {
  databaseIcon: notionIcon("people"),
  properties: {
    Name: Schema.title(),

    Team: Schema.relation("teams", {
      twoWay: true,
      relatedPropertyName: "Members",
    }),

    Managers: Schema.relation("people", {
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
  const managerKeys = [
    ...new Set(
      person.managerWorkdayWids
        .map((wid) => directoryKey("person", wid))
        .filter((key) => key !== personKey)
    ),
  ].sort()

  return {
    type: "upsert",
    key: personKey,
    properties: {
      Name: Builder.title(person.name),
      Team: [Builder.relation(directoryKey("team", person.team.workdayWid))],
      Managers: managerKeys.map((key) => Builder.relation(key)),
      "Directory Key": Builder.richText(personKey),
    },
  }
}
