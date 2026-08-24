import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

import { directoryKey } from "./keys.js"
import type { DirectoryPerson } from "./people.js"

export const INITIAL_TITLE = "Workday Supervisory Organizations"
export const PRIMARY_KEY = "Directory Key"

export type DirectoryOrganization = {
  workdayWid: string
  name: string
}

export const organizationSchema = {
  databaseIcon: notionIcon("briefcase"),
  properties: {
    Name: Schema.title(),
    "Directory Key": Schema.richText(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

export function organizationToChange(
  organization: DirectoryOrganization
): SyncChangeUpsert<typeof PRIMARY_KEY, typeof organizationSchema.properties> {
  const organizationKey = directoryKey("organization", organization.workdayWid)

  return {
    type: "upsert",
    key: organizationKey,
    properties: {
      Name: Builder.title(organization.name),
      "Directory Key": Builder.richText(organizationKey),
    },
  }
}

/**
 * Workday returns organization data once per employee. Collapse it to one
 * deterministic supervisory-organization upsert per response page and reject
 * inconsistent names. Manager relations live on People; deriving them again
 * here would create a circular initial-load dependency and page-order-sensitive
 * duplicate keys.
 */
export function organizationsFromPeople(
  people: DirectoryPerson[]
): DirectoryOrganization[] {
  const organizations = new Map<string, DirectoryOrganization>()

  for (const person of people) {
    const { supervisoryOrganization } = person
    const existing = organizations.get(supervisoryOrganization.workdayWid)

    if (!existing) {
      organizations.set(supervisoryOrganization.workdayWid, {
        workdayWid: supervisoryOrganization.workdayWid,
        name: supervisoryOrganization.name,
      })
      continue
    }

    if (existing.name !== supervisoryOrganization.name) {
      throw new Error(
        "Workday returned inconsistent supervisory organization data."
      )
    }
  }

  return [...organizations.values()].sort((left, right) =>
    left.workdayWid.localeCompare(right.workdayWid)
  )
}
