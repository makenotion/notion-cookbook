import { AGENDA_MAX_CHARS } from "../../lib/config.js"
import {
  companyDomain,
  emailDomain,
  isInternalDomain,
  isNonPersonAddress,
  isPersonalDomain,
  nameFromEmail,
  normalizeEmail,
} from "../../lib/domains.js"

// The subset of the Calendar connection's listEvents output this App reads.
// The SDK does not export the provider types, so they are restated here.
type Period =
  | { type: "DATE"; start: { date: string }; end: { date: string } }
  | {
      type: "DATE_TIME"
      start: { dateTime: string }
      end: { dateTime: string }
    }

export type CalendarEvent = {
  eventId: string
  summary: string
  description?: string
  webUrl: string
  period: Period
  isAutoBlock: boolean
  eventType?: string
  eventStatus?: "confirmed" | "tentative" | "cancelled"
  responseStatus?: "needsAction" | "accepted" | "declined" | "tentative"
  conferencingUrl?: string
  attendees?: Array<{ isSelf: boolean; displayName?: string; email?: string }>
}

export type Account = {
  providerName: string
  email?: string
  category?: "work" | "personal"
  coworkersEmailDomains?: string[]
  calendars: Array<{ isHidden: boolean; events: CalendarEvent[] }>
}

export type ListEventsScriptOutput = { accounts: Account[] }

export type ExternalAttendee = {
  email: string
  name: string
  /** Company domain, or null for personal mailboxes. */
  companyDomain: string | null
}

export type MeetingInput = {
  eventId: string
  title: string
  start: string
  end: string | null
  isAllDay: boolean
  cancelled: boolean
  agenda: string
  calendarUrl: string | null
  videoUrl: string | null
  attendees: ExternalAttendee[]
}

/** Domains treated as internal for an account: its own and its coworkers'. */
export function internalDomainsFor(
  account: Pick<Account, "email" | "coworkersEmailDomains">
): Set<string> {
  const domains = new Set<string>()
  const own = account.email ? emailDomain(account.email) : null
  // A personal account's domain (gmail.com) does not make every gmail.com
  // attendee internal.
  if (own && !isPersonalDomain(own)) domains.add(own)
  for (const domain of account.coworkersEmailDomains ?? []) {
    domains.add(normalizeEmail(domain))
  }
  return domains
}

/** The business account: the first work-category Google account, else the first Google account. */
export function pickBusinessAccount<
  T extends Pick<Account, "providerName" | "category" | "email">,
>(accounts: readonly T[]): T | undefined {
  const google = accounts.filter((account) =>
    /google/i.test(account.providerName)
  )
  const pool = google.length > 0 ? google : accounts
  return pool.find((account) => account.category === "work") ?? pool[0]
}

export function externalAttendees(
  event: CalendarEvent,
  internalDomains: ReadonlySet<string>,
  selfEmail: string | undefined
): ExternalAttendee[] {
  const self = selfEmail ? normalizeEmail(selfEmail) : null
  const byEmail = new Map<string, ExternalAttendee>()
  for (const attendee of event.attendees ?? []) {
    if (attendee.isSelf || !attendee.email) continue
    const email = normalizeEmail(attendee.email)
    if (email === self || isNonPersonAddress(email)) continue
    const domain = emailDomain(email)
    if (!domain || isInternalDomain(domain, internalDomains)) continue
    byEmail.set(email, {
      email,
      name: attendee.displayName?.trim() || nameFromEmail(email),
      companyDomain: isPersonalDomain(domain) ? null : companyDomain(domain),
    })
  }
  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email))
}

export function toMeetingInput(
  event: CalendarEvent,
  internalDomains: ReadonlySet<string>,
  selfEmail: string | undefined
): MeetingInput | null {
  if (event.isAutoBlock) return null
  if (
    event.eventType &&
    event.eventType !== "default" &&
    event.eventType !== "fromGmail"
  )
    return null
  const attendees = externalAttendees(event, internalDomains, selfEmail)
  if (attendees.length === 0) return null
  const period = event.period
  const isAllDay = period.type === "DATE"
  return {
    eventId: event.eventId,
    title: event.summary?.trim() || "Untitled meeting",
    start: isAllDay ? period.start.date : period.start.dateTime,
    end: isAllDay
      ? inclusiveEndDate(period.start.date, period.end.date)
      : period.end.dateTime,
    isAllDay,
    cancelled:
      event.eventStatus === "cancelled" || event.responseStatus === "declined",
    agenda: truncate(stripHtml(event.description ?? ""), AGENDA_MAX_CHARS),
    calendarUrl: event.webUrl || null,
    videoUrl: event.conferencingUrl ?? null,
    attendees,
  }
}

export type ScanOptions = {
  /** Development only: treat coworkers as outside attendees. */
  includeInternal?: boolean
}

function scanDomains(account: Account, options: ScanOptions): Set<string> {
  return options.includeInternal ? new Set() : internalDomainsFor(account)
}

/**
 * Google's all-day end date is exclusive (a one-day event on the 28th ends on
 * the 29th); Notion's is inclusive. Returns null for a single-day event.
 */
export function inclusiveEndDate(
  start: string,
  exclusiveEnd: string
): string | null {
  const [year, month, day] = exclusiveEnd.split("-").map(Number) as [
    number,
    number,
    number,
  ]
  const end = new Date(Date.UTC(year, month - 1, day - 1))
    .toISOString()
    .slice(0, 10)
  return end > start ? end : null
}

/** Every external meeting in a listEvents response, deduplicated by event ID. */
export function meetingsFromListEvents(
  output: ListEventsScriptOutput,
  options: ScanOptions = {}
): MeetingInput[] {
  const account = pickBusinessAccount(output.accounts)
  if (!account) return []
  const internal = scanDomains(account, options)
  const byId = new Map<string, MeetingInput>()
  for (const calendar of account.calendars) {
    if (calendar.isHidden) continue
    for (const event of calendar.events) {
      const meeting = toMeetingInput(event, internal, account.email)
      if (meeting && !byId.has(meeting.eventId))
        byId.set(meeting.eventId, meeting)
    }
  }
  return [...byId.values()]
}

/**
 * Every event ID the business account returned, before any filtering. Used to
 * tell a deleted event apart from one that is merely no longer external.
 */
export function allEventIds(output: ListEventsScriptOutput): string[] {
  const account = pickBusinessAccount(output.accounts)
  const ids = new Set<string>()
  for (const calendar of account?.calendars ?? []) {
    for (const event of calendar.events) ids.add(event.eventId)
  }
  return [...ids]
}

export function attendeeKey(attendees: readonly { email: string }[]): string {
  return attendees
    .map((attendee) => attendee.email)
    .sort()
    .join(", ")
}

export function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

export type ScanDiagnostics = {
  accounts: Array<{
    provider: string
    emailDomain: string | null
    category: string | null
    coworkerDomains: string[]
    calendars: number
    events: number
    picked: boolean
  }>
  internalDomains: string[]
  includeInternal: boolean
  dropped: Record<string, number>
  /** Attendee counts by email domain across every scanned event ("(no email)" when missing). */
  attendeeDomains: Record<string, number>
  /** Up to 10 dropped events: why, and the attendee domains they had. */
  samples: Array<{
    reason: string
    eventType: string | null
    attendeeDomains: string[]
  }>
}

function dropReason(
  event: CalendarEvent,
  internal: ReadonlySet<string>,
  selfEmail: string | undefined
): string | null {
  if (event.isAutoBlock) return "autoBlock"
  if (
    event.eventType &&
    event.eventType !== "default" &&
    event.eventType !== "fromGmail"
  )
    return `eventType:${event.eventType}`
  if (!event.attendees || event.attendees.length === 0) return "noAttendees"
  if (externalAttendees(event, internal, selfEmail).length === 0)
    return "noExternalAttendees"
  return null
}

/** Counts and reasons explaining what a listEvents scan kept, for run logs. */
export function diagnoseListEvents(
  output: ListEventsScriptOutput,
  options: ScanOptions = {}
): ScanDiagnostics {
  const account = pickBusinessAccount(output.accounts)
  const internal = account ? scanDomains(account, options) : new Set<string>()
  const dropped: Record<string, number> = {}
  const attendeeDomains: Record<string, number> = {}
  const samples: ScanDiagnostics["samples"] = []
  for (const calendar of account?.calendars ?? []) {
    for (const event of calendar.events) {
      for (const attendee of event.attendees ?? []) {
        const domain = attendee.email
          ? (emailDomain(attendee.email) ?? "(invalid)")
          : "(no email)"
        attendeeDomains[domain] = (attendeeDomains[domain] ?? 0) + 1
      }
      const reason = calendar.isHidden
        ? "hiddenCalendar"
        : dropReason(event, internal, account?.email)
      if (!reason) continue
      dropped[reason] = (dropped[reason] ?? 0) + 1
      if (samples.length < 10) {
        samples.push({
          reason,
          eventType: event.eventType ?? null,
          attendeeDomains: [
            ...new Set(
              (event.attendees ?? []).flatMap((a) =>
                a.email ? (emailDomain(a.email) ?? []) : []
              )
            ),
          ],
        })
      }
    }
  }
  return {
    accounts: output.accounts.map((a) => ({
      provider: a.providerName,
      emailDomain: a.email ? emailDomain(a.email) : null,
      category: a.category ?? null,
      coworkerDomains: a.coworkersEmailDomains ?? [],
      calendars: a.calendars.length,
      events: a.calendars.reduce((sum, c) => sum + c.events.length, 0),
      picked: a === account,
    })),
    internalDomains: [...internal],
    includeInternal: options.includeInternal === true,
    dropped,
    attendeeDomains,
    samples,
  }
}

/** A meeting that already happened with an attendee. */
export type PastMeeting = {
  eventId: string
  title: string
  start: string
  calendarUrl: string | null
}

/**
 * Past meetings with each of the given attendees, newest first and at most
 * `limit` each. Only meetings that happened count: cancelled, declined, and
 * auto-block events are left out, as are events that have not ended yet.
 */
export function pastMeetingsWith(
  outputs: readonly ListEventsScriptOutput[],
  emails: readonly string[],
  now: number,
  limit: number
): Record<string, PastMeeting[]> {
  const wanted = new Set(emails.map(normalizeEmail))
  const byEmail = new Map<string, Map<string, PastMeeting>>()
  for (const output of outputs) {
    const account = pickBusinessAccount(output.accounts)
    for (const calendar of account?.calendars ?? []) {
      if (calendar.isHidden) continue
      for (const event of calendar.events) {
        if (
          event.isAutoBlock ||
          event.eventStatus === "cancelled" ||
          event.responseStatus === "declined"
        )
          continue
        const period = event.period
        const start =
          period.type === "DATE" ? period.start.date : period.start.dateTime
        const end =
          period.type === "DATE" ? period.end.date : period.end.dateTime
        if (!(Date.parse(end) <= now)) continue
        for (const attendee of event.attendees ?? []) {
          const email = attendee.email ? normalizeEmail(attendee.email) : ""
          if (!wanted.has(email)) continue
          const meetings = byEmail.get(email) ?? new Map<string, PastMeeting>()
          meetings.set(event.eventId, {
            eventId: event.eventId,
            title: event.summary?.trim() || "Untitled meeting",
            start,
            calendarUrl: event.webUrl || null,
          })
          byEmail.set(email, meetings)
        }
      }
    }
  }
  const result: Record<string, PastMeeting[]> = {}
  for (const email of wanted) {
    result[email] = [...(byEmail.get(email)?.values() ?? [])]
      .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
      .slice(0, limit)
  }
  return result
}
