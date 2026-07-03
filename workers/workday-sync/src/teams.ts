import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

import { directoryKey } from "./keys.js"
import type { DirectoryPerson } from "./people.js"

export const INITIAL_TITLE = "Workday Teams"
export const PRIMARY_KEY = "Directory Key"

export type DirectoryTeam = {
  workdayWid: string
  name: string
}

export const teamSchema = {
  databaseIcon: notionIcon("briefcase"),
  properties: {
    Name: Schema.title(),
    "Directory Key": Schema.richText(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

export function teamToChange(
  team: DirectoryTeam
): SyncChangeUpsert<typeof PRIMARY_KEY, typeof teamSchema.properties> {
  const teamKey = directoryKey("team", team.workdayWid)

  return {
    type: "upsert",
    key: teamKey,
    properties: {
      Name: Builder.title(team.name),
      "Directory Key": Builder.richText(teamKey),
    },
  }
}

/**
 * Workday returns organization data once per employee. Collapse it to one
 * deterministic team upsert per response page and reject inconsistent names.
 * Manager relations live on People; deriving them again on Teams would create
 * a circular initial-load dependency and page-order-sensitive duplicate keys.
 */
export function teamsFromPeople(people: DirectoryPerson[]): DirectoryTeam[] {
  const teams = new Map<string, DirectoryTeam>()

  for (const person of people) {
    const existing = teams.get(person.team.workdayWid)

    if (!existing) {
      teams.set(person.team.workdayWid, {
        workdayWid: person.team.workdayWid,
        name: person.team.name,
      })
      continue
    }

    if (existing.name !== person.team.name) {
      throw new Error(
        "Workday returned inconsistent supervisory organization data."
      )
    }
  }

  return [...teams.values()].sort((left, right) =>
    left.workdayWid.localeCompare(right.workdayWid)
  )
}
