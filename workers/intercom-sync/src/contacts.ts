import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

import {
  type ContactDirectory,
  type IntercomClient,
  type IntercomContact,
} from "./intercom.js"
import {
  humanize,
  nonEmpty,
  optionalUnixSecondsToIso,
  uniqueStrings,
  unixSecondsToIso,
} from "./helpers.js"
import { nextCursorState, type CursorSyncState } from "./pagination.js"

export const INITIAL_TITLE = "Intercom Contacts"
export const PRIMARY_KEY = "Contact ID"

export const contactSchema = {
  databaseIcon: notionIcon("people"),
  properties: {
    Name: Schema.title(),

    Role: Schema.select([{ name: "User" }, { name: "Lead" }]),

    Owner: Schema.richText(),

    Updated: Schema.date(),

    Email: Schema.email(),

    Phone: Schema.phoneNumber(),

    Companies: Schema.relation("companies", {
      twoWay: true,
      relatedPropertyName: "Contacts",
    }),

    Country: Schema.select([]),

    Tags: Schema.multiSelect([]),

    "Incomplete Associations": Schema.multiSelect([
      { name: "Companies" },
      { name: "Tags" },
    ]),

    "Last Seen": Schema.date(),

    "Signed Up": Schema.date(),

    "Last Contacted": Schema.date(),

    "Last Replied": Schema.date(),

    "Email Restrictions": Schema.multiSelect([
      { name: "Unsubscribed" },
      { name: "Marked spam" },
      { name: "Hard bounced" },
    ]),

    Created: Schema.date(),

    "External ID": Schema.richText(),

    "Contact ID": Schema.richText(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

function contactName(contact: IntercomContact): string {
  return (
    nonEmpty(contact.name) ??
    nonEmpty(contact.email) ??
    nonEmpty(contact.phone) ??
    nonEmpty(contact.external_id) ??
    `Contact ${contact.id}`
  )
}

function contactId(contact: IntercomContact): string {
  const id = nonEmpty(contact.id)
  if (!id) throw new Error("Intercom contact is missing its id.")
  return id
}

function roleName(value: string | null | undefined): string | undefined {
  const role = nonEmpty(value)
  return role ? humanize(role) : undefined
}

function ownerName(
  ownerId: string | number | null | undefined,
  directory: ContactDirectory
): string | undefined {
  if (ownerId == null) return undefined
  const id = String(ownerId).trim()
  if (!id || id === "0") return undefined
  return directory.admins.get(id) ?? `Unknown admin (${id})`
}

function companyIds(contact: IntercomContact): string[] {
  return uniqueStrings(
    (contact.companies?.data ?? []).map((company) => company.id ?? undefined)
  )
}

function tagNames(
  contact: IntercomContact,
  directory: ContactDirectory
): string[] {
  return uniqueStrings(
    (contact.tags?.data ?? []).map((tag) => {
      const id = nonEmpty(tag.id)
      return (
        nonEmpty(tag.name) ??
        (id ? (directory.tags.get(id) ?? `Unknown tag (${id})`) : undefined)
      )
    })
  )
}

function emailRestrictions(contact: IntercomContact): string[] {
  return [
    contact.unsubscribed_from_emails ? "Unsubscribed" : undefined,
    contact.marked_email_as_spam ? "Marked spam" : undefined,
    contact.has_hard_bounced ? "Hard bounced" : undefined,
  ].filter((value): value is string => value !== undefined)
}

function incompleteAssociations(contact: IntercomContact): string[] {
  const companies = contact.companies
  const tags = contact.tags
  const companiesIncomplete =
    companies?.has_more === true ||
    (Number.isSafeInteger(companies?.total_count) &&
      (companies?.total_count ?? 0) > (companies?.data?.length ?? 0)) ||
    (companies?.has_more == null &&
      !Number.isSafeInteger(companies?.total_count) &&
      (companies?.data?.length ?? 0) >= 10)
  const tagsIncomplete =
    tags?.has_more === true ||
    (Number.isSafeInteger(tags?.total_count) &&
      (tags?.total_count ?? 0) > (tags?.data?.length ?? 0)) ||
    (tags?.has_more == null &&
      !Number.isSafeInteger(tags?.total_count) &&
      (tags?.data?.length ?? 0) >= 10)
  return [
    companiesIncomplete ? "Companies" : undefined,
    tagsIncomplete ? "Tags" : undefined,
  ].filter((value): value is string => value !== undefined)
}

export function contactToChange(
  contact: IntercomContact,
  directory: ContactDirectory
): SyncChangeUpsert<typeof PRIMARY_KEY, typeof contactSchema.properties> {
  const id = contactId(contact)
  const updated = unixSecondsToIso(contact.updated_at, "Contact updated_at")
  const created = unixSecondsToIso(contact.created_at, "Contact created_at")
  const role = roleName(contact.role)
  const owner = ownerName(contact.owner_id, directory)
  const email = nonEmpty(contact.email)
  const phone = nonEmpty(contact.phone)
  const companies = companyIds(contact)
  const country = nonEmpty(contact.location?.country)
  const tags = tagNames(contact, directory)
  const incomplete = incompleteAssociations(contact)
  const lastSeen = optionalUnixSecondsToIso(
    contact.last_seen_at,
    "Contact last_seen_at"
  )
  const signedUp = optionalUnixSecondsToIso(
    contact.signed_up_at,
    "Contact signed_up_at"
  )
  const lastContacted = optionalUnixSecondsToIso(
    contact.last_contacted_at,
    "Contact last_contacted_at"
  )
  const lastReplied = optionalUnixSecondsToIso(
    contact.last_replied_at,
    "Contact last_replied_at"
  )
  const restrictions = emailRestrictions(contact)
  const externalId = nonEmpty(contact.external_id)

  return {
    type: "upsert",
    key: id,
    upstreamUpdatedAt: updated,
    properties: {
      Name: Builder.title(contactName(contact)),
      Role: role ? Builder.select(role) : [],
      Owner: owner ? Builder.richText(owner) : [],
      Updated: Builder.dateTime(updated),
      Email: email ? Builder.email(email) : [],
      Phone: phone ? Builder.phoneNumber(phone) : [],
      Companies: companies.map((companyId) => Builder.relation(companyId)),
      Country: country ? Builder.select(country) : [],
      Tags: tags.length > 0 ? Builder.multiSelect(...tags) : [],
      "Incomplete Associations":
        incomplete.length > 0 ? Builder.multiSelect(...incomplete) : [],
      "Last Seen": lastSeen ? Builder.dateTime(lastSeen) : [],
      "Signed Up": signedUp ? Builder.dateTime(signedUp) : [],
      "Last Contacted": lastContacted ? Builder.dateTime(lastContacted) : [],
      "Last Replied": lastReplied ? Builder.dateTime(lastReplied) : [],
      "Email Restrictions":
        restrictions.length > 0 ? Builder.multiSelect(...restrictions) : [],
      Created: Builder.dateTime(created),
      "External ID": externalId ? Builder.richText(externalId) : [],
      "Contact ID": Builder.richText(id),
    },
  }
}

export async function runContactsPage(
  client: IntercomClient,
  directory: ContactDirectory,
  state: CursorSyncState | undefined
) {
  const page = await client.listContacts(state?.after)
  const changes = page.records.map((contact) =>
    contactToChange(contact, directory)
  )

  if (page.nextCursor) {
    return {
      changes,
      hasMore: true as const,
      nextState: nextCursorState(state, page.nextCursor, "contacts"),
    }
  }
  return { changes, hasMore: false as const }
}
