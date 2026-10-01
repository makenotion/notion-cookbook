import { PREP_STATUS } from "../../notion.js"

// Choosing which meetings a no-input "Research companies and people" run
// preps. Research runs per meeting: one session covers the meeting's brief,
// its attendees, and their companies. So the backlog is a list of meetings
// chosen to cover every unresearched person and company.

/** At most this many meetings are prepped per manual run. */
export const BACKLOG_MAX_MEETINGS = 10
/** Meetings that started longer ago than this are not considered. */
export const BACKLOG_LOOKBACK_DAYS = 30

export type BacklogMeeting = {
  id: string
  startMs: number
  endMs: number
  /** Prep status, or null when empty. */
  prepStatus: string | null
  /** Outside attendee emails, lowercased. */
  attendees: readonly string[]
}

export type BacklogPerson = {
  email: string
  /** Lowercased company domain; empty for personal mailboxes. */
  companyDomain: string
  /** Whether research has filled in anything about this person. */
  researched: boolean
}

export type BacklogPick = {
  id: string
  /** Why the meeting was picked, for the run log. */
  reasons: string[]
}

/**
 * A person counts as researched once research saved a role or a confidence
 * for them. A company counts as researched once it has a summary.
 */
export function personResearched(person: {
  role: string
  confidence: string | null
}): boolean {
  return person.role.trim() !== "" || person.confidence !== null
}

/**
 * The meetings to prep, in order, and how many more qualified beyond the cap.
 *
 * A meeting qualifies when either:
 * - it has not ended and its prep never finished (Prep status empty, Queued,
 *   or Failed), or
 * - it includes an attendee or company that is still unresearched and that
 *   no earlier pick already covers.
 *
 * Meetings being researched now are skipped, as are meetings without outside
 * attendees. Upcoming meetings come first, soonest first, then past meetings,
 * most recent first.
 */
export function selectBacklog(
  meetings: readonly BacklogMeeting[],
  people: readonly BacklogPerson[],
  researchedCompanies: ReadonlySet<string>,
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

  const coveredPeople = new Set<string>()
  const coveredCompanies = new Set<string>()
  const qualified: BacklogPick[] = []
  for (const meeting of [...upcoming, ...past]) {
    if (meeting.attendees.length === 0) continue
    if (meeting.prepStatus === PREP_STATUS.researching) continue
    const reasons: string[] = []
    const unfinished =
      meeting.prepStatus === null ||
      meeting.prepStatus === PREP_STATUS.queued ||
      meeting.prepStatus === PREP_STATUS.failed
    if (meeting.endMs > now && unfinished)
      reasons.push(`prep ${(meeting.prepStatus ?? "empty").toLowerCase()}`)
    const newPeople: string[] = []
    const newCompanies = new Set<string>()
    for (const email of meeting.attendees) {
      const person = byEmail.get(email)
      if (!person) continue
      if (!person.researched && !coveredPeople.has(email)) newPeople.push(email)
      const domain = person.companyDomain
      if (
        domain &&
        !researchedCompanies.has(domain) &&
        !coveredCompanies.has(domain)
      )
        newCompanies.add(domain)
    }
    if (newPeople.length > 0)
      reasons.push(`${newPeople.length} unresearched attendee(s)`)
    if (newCompanies.size > 0)
      reasons.push(`${newCompanies.size} unresearched company(ies)`)
    if (reasons.length === 0) continue
    // Prepping this meeting researches all of its attendees and companies.
    for (const email of meeting.attendees) {
      coveredPeople.add(email)
      const domain = byEmail.get(email)?.companyDomain
      if (domain) coveredCompanies.add(domain)
    }
    qualified.push({ id: meeting.id, reasons })
  }
  return {
    picks: qualified.slice(0, max),
    remaining: Math.max(0, qualified.length - max),
  }
}
