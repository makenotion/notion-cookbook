import { PREP_STATUS } from "../../notion.js"

// Choosing which meetings a no-input "Prepare research" run
// preps. Research runs per meeting: one session covers the meeting's brief,
// its attendees, and their companies in the saved context. Profiles have their
// own Ready handoff; a queued profile counts as covered for meeting selection.

/** At most this many meetings are prepped per manual run. */
export const BACKLOG_MAX_MEETINGS = 10
/** Meetings that started longer ago than this are not considered. */
export const BACKLOG_LOOKBACK_DAYS = 30
/** A Failed meeting is retried only once its last attempt is this old. */
export const FAILED_RETRY_MS = 6 * 60 * 60 * 1000
/**
 * A meeting Researching for longer than this is treated as stuck (its run
 * crashed or timed out) and retried. A prep polls for at most 10 minutes.
 */
export const STALE_RESEARCH_MS = 20 * 60 * 1000

export type BacklogMeeting = {
  id: string
  startMs: number
  endMs: number
  /** Prep status, or null when empty. */
  prepStatus: string | null
  /** When the meeting row last changed: its last prep attempt or later. */
  lastEditedMs: number | null
  /** Outside attendee emails, lowercased. */
  attendees: readonly string[]
}

export type BacklogPerson = {
  email: string
  /** Lowercased company domain; empty for personal mailboxes. */
  companyDomain: string
  /** Whether profile research was queued or previously completed. */
  attempted: boolean
}

export type BacklogPick = {
  id: string
  /** Why the meeting was picked, for the run log. */
  reasons: string[]
}

/**
 * Research has reached a person once a research session returned for one of
 * their meetings (Researched at), even if it found nothing. People researched
 * before Researched at existed count through their Role or Confidence.
 */
export function personAttempted(person: {
  researchedAt: string | null
  role: string
  confidence: string | null
}): boolean {
  return (
    person.researchedAt !== null ||
    person.role.trim() !== "" ||
    person.confidence !== null
  )
}

/** The same for a company, whose older research shows as a Summary. */
export function companyAttempted(company: {
  researchedAt: string | null
  summary: string
}): boolean {
  return company.researchedAt !== null || company.summary.trim() !== ""
}

/**
 * The meetings to prep, in order, and how many more qualified beyond the cap.
 *
 * Skipped: meetings without outside attendees, meetings Researching now
 * (unless stuck for STALE_RESEARCH_MS), and Failed meetings whose last attempt
 * is newer than FAILED_RETRY_MS. A failed session does not stamp Researched
 * at, so the cooldown is what stops a persistent failure being retried on
 * every run.
 *
 * Picked first: meetings with a person or company research has never queued
 * that no earlier pick covers. Then: upcoming meetings whose prep never
 * finished (empty, Queued, Failed, or stuck Researching). Within each group,
 * upcoming meetings come first, soonest first, then past ones, most recent
 * first.
 */
export function selectBacklog(
  meetings: readonly BacklogMeeting[],
  people: readonly BacklogPerson[],
  attemptedCompanies: ReadonlySet<string>,
  now: number,
  max = BACKLOG_MAX_MEETINGS
): { picks: BacklogPick[]; remaining: number } {
  const byEmail = new Map(people.map((person) => [person.email, person]))
  const upcoming = meetings
    .filter((meeting) => meeting.endMs > now)
    .sort((a, b) => a.startMs - b.startMs)
  const past = meetings
    .filter((meeting) => meeting.endMs <= now)
    .sort((a, b) => b.startMs - a.startMs)
  const age = (meeting: BacklogMeeting) =>
    meeting.lastEditedMs === null ? Infinity : now - meeting.lastEditedMs
  const candidates = [...upcoming, ...past].filter((meeting) => {
    if (meeting.attendees.length === 0) return false
    if (meeting.prepStatus === PREP_STATUS.researching)
      return age(meeting) > STALE_RESEARCH_MS
    if (meeting.prepStatus === PREP_STATUS.failed)
      return age(meeting) > FAILED_RETRY_MS
    return true
  })

  const coveredPeople = new Set<string>()
  const coveredCompanies = new Set<string>()
  const cover = (meeting: BacklogMeeting) => {
    for (const email of meeting.attendees) {
      coveredPeople.add(email)
      const domain = byEmail.get(email)?.companyDomain
      if (domain) coveredCompanies.add(domain)
    }
  }
  const statusReason = (meeting: BacklogMeeting): string | null => {
    if (meeting.endMs <= now) return null
    switch (meeting.prepStatus) {
      case null:
        return "prep empty"
      case PREP_STATUS.queued:
        return "prep queued"
      case PREP_STATUS.failed:
        return "prep failed"
      case PREP_STATUS.researching:
        return "prep stuck researching"
      default:
        return null
    }
  }

  // First, meetings that reach people or companies research never reached.
  const first: BacklogPick[] = []
  const picked = new Set<string>()
  for (const meeting of candidates) {
    let newPeople = 0
    const newCompanies = new Set<string>()
    for (const email of meeting.attendees) {
      const person = byEmail.get(email)
      if (!person) continue
      if (!person.attempted && !coveredPeople.has(email)) newPeople++
      const domain = person.companyDomain
      if (
        domain &&
        !attemptedCompanies.has(domain) &&
        !coveredCompanies.has(domain)
      )
        newCompanies.add(domain)
    }
    if (newPeople === 0 && newCompanies.size === 0) continue
    const reasons: string[] = []
    if (newPeople > 0) reasons.push(`${newPeople} unresearched attendee(s)`)
    if (newCompanies.size > 0)
      reasons.push(`${newCompanies.size} unresearched company(ies)`)
    const status = statusReason(meeting)
    if (status) reasons.unshift(status)
    cover(meeting)
    picked.add(meeting.id)
    first.push({ id: meeting.id, reasons })
  }

  // Then upcoming meetings whose prep never finished.
  const second: BacklogPick[] = []
  for (const meeting of candidates) {
    if (picked.has(meeting.id)) continue
    const status = statusReason(meeting)
    if (status) second.push({ id: meeting.id, reasons: [status] })
  }

  const qualified = [...first, ...second]
  return {
    picks: qualified.slice(0, max),
    remaining: Math.max(0, qualified.length - max),
  }
}
