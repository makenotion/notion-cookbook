import type { WorkflowContext } from "@notionhq/apps"

import {
  bestName,
  companyNameFromDomain,
  isPlaceholderName,
  nameFromEmail,
} from "../../lib/domains.js"
import {
  findOne,
  prop,
  queryAll,
  read,
  type Notion,
  type PropertyMap,
} from "../../lib/props.js"
import { MEETING_STATUS, PREP_STATUS } from "../../notion.js"
import { attendeeKey, type MeetingInput } from "./calendar.js"
import { readyForResearch } from "./research.js"

export type DataSourceIds = {
  meetings: string
  people: string
  companies: string
}

/** Name and photo from the calendar account's contacts, keyed by email. */
export type ContactInfo = { name: string | null; photoUrl: string | null }
export type Contacts = Record<string, ContactInfo>

type Step = WorkflowContext["step"]

/** What ingest compares to decide whether a stored meeting needs an update. */
export type StoredMeeting = {
  pageId: string
  title: string
  start: string | null
  end: string | null
  status: string | null
  attendees: string
  agenda: string
  videoUrl: string | null
  calendarUrl: string | null
}

export async function loadStoredMeetings(
  notion: Notion,
  meetingsId: string,
  fromIso: string
): Promise<Record<string, StoredMeeting>> {
  const pages = await queryAll(notion, {
    data_source_id: meetingsId,
    filter: { property: "When", date: { on_or_after: fromIso } },
  })
  const byEventId: Record<string, StoredMeeting> = {}
  for (const page of pages) {
    const eventId = read.text(page.properties, "Event ID")
    if (!eventId) continue
    const when = read.date(page.properties, "When")
    byEventId[eventId] = {
      pageId: page.id,
      title: read.title(page.properties, "Title"),
      start: when?.start ?? null,
      end: when?.end ?? null,
      status: read.select(page.properties, "Status"),
      attendees: read.text(page.properties, "Attendee emails"),
      agenda: read.text(page.properties, "Agenda"),
      videoUrl: read.url(page.properties, "Video link"),
      calendarUrl: read.url(page.properties, "Calendar link"),
    }
  }
  return byEventId
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  // All-day values are plain dates; compare those as strings.
  if (a.length === 10 || b.length === 10)
    return a.slice(0, 10) === b.slice(0, 10)
  return Date.parse(a) === Date.parse(b)
}

export function meetingStatus(meeting: MeetingInput): string {
  return meeting.cancelled ? MEETING_STATUS.cancelled : MEETING_STATUS.scheduled
}

export function needsUpdate(
  meeting: MeetingInput,
  stored: StoredMeeting | undefined
): boolean {
  if (!stored) return true
  return (
    stored.title !== meeting.title ||
    !sameInstant(stored.start, meeting.start) ||
    !sameInstant(stored.end, meeting.end) ||
    stored.status !== meetingStatus(meeting) ||
    stored.attendees !== attendeeKey(meeting.attendees) ||
    stored.agenda !== meeting.agenda ||
    stored.videoUrl !== meeting.videoUrl ||
    stored.calendarUrl !== meeting.calendarUrl
  )
}

/**
 * Create or update the People, Companies, and Meetings rows for each
 * meeting. Every write is its own keyed step and looks up the row by its
 * stable key first, so a replayed or retried run does not duplicate rows.
 */
export async function upsertMeetings(
  step: Step,
  notion: Notion,
  ids: DataSourceIds,
  meetings: readonly MeetingInput[],
  stored: Record<string, StoredMeeting>,
  contacts: Contacts = {}
): Promise<{ created: number; updated: number }> {
  const companyIds = new Map<string, string>()
  const personIds = new Map<string, string>()
  let created = 0
  let updated = 0

  for (const meeting of meetings) {
    const existing = stored[meeting.eventId]
    if (!needsUpdate(meeting, existing)) continue

    for (const attendee of meeting.attendees) {
      const domain = attendee.companyDomain
      if (domain && !companyIds.has(domain)) {
        const id = await step(
          "Upsert company",
          { key: ["company", domain] },
          () => upsertCompany(notion, ids.companies, domain)
        )
        companyIds.set(domain, id)
      }
      if (!personIds.has(attendee.email)) {
        const companyId = domain ? (companyIds.get(domain) ?? null) : null
        const id = await step(
          "Upsert person",
          { key: ["person", attendee.email] },
          () =>
            upsertPerson(
              notion,
              ids.people,
              attendee.email,
              attendee.name,
              domain,
              companyId,
              contacts[attendee.email]
            )
        )
        personIds.set(attendee.email, id)
      }
    }

    const attendeeIds = meeting.attendees.flatMap(
      (a) => personIds.get(a.email) ?? []
    )
    const meetingCompanyIds = [
      ...new Set(
        meeting.attendees.flatMap((a) =>
          a.companyDomain ? (companyIds.get(a.companyDomain) ?? []) : []
        )
      ),
    ]
    const result = await step(
      "Upsert meeting",
      { key: ["meeting", meeting.eventId] },
      () =>
        upsertMeeting(
          notion,
          ids.meetings,
          meeting,
          attendeeIds,
          meetingCompanyIds,
          existing
        )
    )
    if (result === "created") created += 1
    else updated += 1
  }
  return { created, updated }
}

async function upsertCompany(
  notion: Notion,
  companiesId: string,
  domain: string
): Promise<string> {
  const existing = await findOne(notion, companiesId, {
    property: "Domain",
    rich_text: { equals: domain },
  })
  if (existing) {
    await readyForResearch(notion, existing.id)
    return existing.id
  }
  const page = await notion.pages.create({
    parent: { data_source_id: companiesId },
    properties: {
      Name: prop.title(companyNameFromDomain(domain)),
      Domain: prop.text(domain),
      Website: prop.url(`https://${domain}`),
    },
  })
  await readyForResearch(notion, page.id)
  return page.id
}

async function upsertPerson(
  notion: Notion,
  peopleId: string,
  email: string,
  calendarName: string,
  domain: string | null,
  companyId: string | null,
  contact: ContactInfo | undefined
): Promise<string> {
  const name = bestName(email, calendarName, contact?.name)
  const photo = contact?.photoUrl ?? null
  const existing = await findOne(notion, peopleId, {
    property: "Email",
    email: { equals: email },
  })
  if (existing) {
    const properties: PropertyMap = {}
    if (
      companyId &&
      read.relation(existing.properties, "Company").length === 0
    ) {
      properties.Company = prop.relation([companyId])
      properties["Company domain"] = prop.text(domain ?? "")
    }
    // Only replace a placeholder name, never one a person typed.
    if (
      name &&
      isPlaceholderName(read.title(existing.properties, "Name"), email)
    )
      properties.Name = prop.title(name)
    if (photo && !read.url(existing.properties, "Photo"))
      properties.Photo = prop.url(photo)
    if (Object.keys(properties).length > 0) {
      await notion.pages.update({ page_id: existing.id, properties })
    }
    await readyForResearch(notion, existing.id)
    return existing.id
  }
  const properties: PropertyMap = {
    Name: prop.title(name ?? nameFromEmail(email)),
    Email: prop.email(email),
    "Company domain": prop.text(domain ?? ""),
  }
  if (photo) properties.Photo = prop.url(photo)
  if (companyId) properties.Company = prop.relation([companyId])
  const page = await notion.pages.create({
    parent: { data_source_id: peopleId },
    properties,
  })
  await readyForResearch(notion, page.id)
  return page.id
}

/** Emails of attendees in meetings that ingest will write. */
export function attendeesToWrite(
  meetings: readonly MeetingInput[],
  stored: Record<string, StoredMeeting>
): string[] {
  const emails = new Set<string>()
  for (const meeting of meetings) {
    if (!needsUpdate(meeting, stored[meeting.eventId])) continue
    for (const attendee of meeting.attendees) emails.add(attendee.email)
  }
  return [...emails].sort()
}

type ContactsOutput = {
  accounts: Array<{
    contacts?: Array<{
      email: string
      alternateEmails?: string[]
      displayName?: string
      photoUrl?: string
    }>
  }>
}

/** Map a listContacts response onto the requested emails. */
export function contactsByEmail(
  output: ContactsOutput,
  emails: readonly string[]
): Contacts {
  const wanted = new Set(emails)
  const result: Contacts = {}
  for (const account of output.accounts) {
    for (const contact of account.contacts ?? []) {
      for (const address of [
        contact.email,
        ...(contact.alternateEmails ?? []),
      ]) {
        const email = address.trim().toLowerCase()
        if (!wanted.has(email) || result[email]?.name) continue
        result[email] = {
          name: contact.displayName?.trim() || null,
          photoUrl: contact.photoUrl ?? null,
        }
      }
    }
  }
  return result
}

async function upsertMeeting(
  notion: Notion,
  meetingsId: string,
  meeting: MeetingInput,
  attendeeIds: string[],
  companyIds: string[],
  stored: StoredMeeting | undefined
): Promise<"created" | "updated"> {
  const attendees = attendeeKey(meeting.attendees)
  const properties: PropertyMap = {
    Title: prop.title(meeting.title),
    When: prop.date(meeting.start, meeting.end),
    Status: prop.select(meetingStatus(meeting)),
    Attendees: prop.relation(attendeeIds),
    Companies: prop.relation(companyIds),
    Agenda: prop.text(meeting.agenda),
    "Calendar link": prop.url(meeting.calendarUrl),
    "Video link": prop.url(meeting.videoUrl),
  }
  // Write the attendee key only when it changes: prep watches this property.
  if (stored?.attendees !== attendees)
    properties["Attendee emails"] = prop.text(attendees)

  // The stored snapshot can be stale after a retry; look the row up again.
  const pageId =
    stored?.pageId ??
    (
      await findOne(notion, meetingsId, {
        property: "Event ID",
        rich_text: { equals: meeting.eventId },
      })
    )?.id
  if (pageId) {
    await notion.pages.update({ page_id: pageId, properties })
    return "updated"
  }
  properties["Event ID"] = prop.text(meeting.eventId)
  properties["Prep status"] = prop.select(PREP_STATUS.queued)
  await notion.pages.create({
    parent: { data_source_id: meetingsId },
    properties,
  })
  return "created"
}

export async function cancelMeeting(
  notion: Notion,
  pageId: string
): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: { Status: prop.select(MEETING_STATUS.cancelled) },
  })
}
