import type { WorkflowContext } from "@notionhq/apps"
import { calendar } from "../../connections/calendar.js"

import { EMAIL_LOOKBACK_DAYS, TIME_ZONE } from "../../lib/config.js"
import {
  bestName,
  companyNameFromDomain,
  isPlaceholderName,
  normalizeEmail,
} from "../../lib/domains.js"
import { asPage, findOne, prop, read, type Notion } from "../../lib/props.js"
import {
  CONFIDENCE,
  MEETING_STATUS,
  PREP_STATUS,
  RESEARCH_STATUS,
} from "../../notion.js"
import { emailLines, senderName, type EmailThread } from "./email.js"
import {
  pastMeetingsWith,
  truncate,
  type ListEventsScriptOutput,
  type PastMeeting,
} from "./calendar.js"
import { contactsByEmail, type Contacts } from "./ingest.js"
import { isRuntimeSignal } from "./runtime.js"
import { needsResearch, readyForResearch } from "./research.js"

// Mail is temporarily disabled. Both prep workflows use the shared Calendar.
type PrepContext = Pick<WorkflowContext, "step" | "notion" | "wait">

export type PrepReason = "created" | "updated" | "morning" | "force"

type MeetingSnapshot = {
  title: string
  start: string | null
  end: string | null
  status: string | null
  agenda: string
  attendees: string
  preppedFor: string
  regenerate: boolean
  endedAt: number | null
  now: number
  researchStatus?: string | null
  requestedFor?: string
  prepStatus?: string | null
}

export type Profiles = {
  linkedin: string | null
  x: string | null
  instagram: string | null
  website: string | null
}

export type Attendee = {
  id: string
  name: string
  email: string
  role: string
  photo: string | null
  companyDomain: string | null
  /** The People Confidence status, or null before research finds a match. */
  confidence: string | null
  profiles: Profiles
}

/** The People property that stores each profile URL. */
export const PROFILE_PROPERTIES = {
  linkedin: "LinkedIn",
  x: "X",
  instagram: "Instagram",
  website: "Personal site",
} as const satisfies Record<keyof Profiles, string>

const PROFILE_KEYS = Object.keys(PROFILE_PROPERTIES) as Array<keyof Profiles>
export type Company = {
  id: string
  name: string
  domain: string
  summary: string
}

/** Decide whether a trigger should prepare context for a new brief request. */
export function shouldPrep(
  reason: PrepReason,
  meeting: MeetingSnapshot
): boolean {
  if (meeting.status === MEETING_STATUS.cancelled) return false
  if (meeting.attendees === "") return false
  if (
    reason !== "force" &&
    !meeting.regenerate &&
    meeting.requestedFor === meeting.attendees &&
    (meeting.researchStatus === RESEARCH_STATUS.ready ||
      meeting.researchStatus === RESEARCH_STATUS.researching ||
      (!meeting.researchStatus &&
        (meeting.prepStatus === PREP_STATUS.queued ||
          meeting.prepStatus === PREP_STATUS.researching)))
  )
    return false
  if (meeting.regenerate || reason === "force") return true
  if (meeting.endedAt !== null && meeting.endedAt < meeting.now) return false
  switch (reason) {
    case "created":
      return meeting.preppedFor === ""
    case "updated":
      // Our own writes also fire update events; only act on a real change.
      return meeting.preppedFor !== meeting.attendees
    case "morning":
      return true
  }
}

export type PrepTargets = {
  meetings: string
  people: string
  companies: string
}

export function prepTargets(access: {
  meetings: { id: string }
  people: { id: string }
  companies: { id: string }
}): PrepTargets {
  return {
    meetings: access.meetings.id,
    people: access.people.id,
    companies: access.companies.id,
  }
}

// Include recent calendar history in the meeting context.
const HISTORY_DAYS = 90
const HISTORY_MEETINGS = 10
// The Calendar connection lists at most a month per call.
const LIST_EVENTS_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const PROFILE_WAIT_MS = 20 * 60 * 1000

export async function runPrep(
  context: PrepContext,
  targets: PrepTargets,
  meetingPageId: string,
  reason: PrepReason
): Promise<void> {
  const { step, notion } = context
  // Scope every step key to the meeting so one run can prep several meetings.
  const key = (...parts: string[]) => ({ key: [...parts, meetingPageId] })

  const meeting = await step("Load meeting", key("load-meeting"), async () => {
    const page = asPage(await notion.pages.retrieve({ page_id: meetingPageId }))
    const when = read.date(page.properties, "When")
    const endIso = when?.end ?? when?.start ?? null
    return {
      title: read.title(page.properties, "Title"),
      start: when?.start ?? null,
      end: when?.end ?? null,
      status: read.select(page.properties, "Status"),
      agenda: read.text(page.properties, "Agenda"),
      attendees: read.text(page.properties, "Attendee emails"),
      preppedFor: read.text(page.properties, "Prepped for"),
      regenerate: read.checkbox(page.properties, "Regenerate prep"),
      endedAt: endIso ? Date.parse(endIso) : null,
      now: Date.now(),
      researchStatus: read.select(page.properties, "Research status"),
      requestedFor: read.text(page.properties, "Requested for"),
      prepStatus: read.select(page.properties, "Prep status"),
      previousContext: read.text(page.properties, "Research context"),
    } satisfies MeetingSnapshot & { previousContext: string }
  })
  if (!shouldPrep(reason, meeting)) return

  const request = await step("Choose research request", key("request"), () => ({
    id: crypto.randomUUID(),
    startedAt: Date.now(),
  }))
  const prefix = `Request ID: ${request.id}\nRequested at: ${new Date(request.startedAt).toISOString()}\n\n`
  const isCurrent = (properties: Record<string, unknown>) =>
    read.text(properties, "Attendee emails") === meeting.attendees &&
    read.text(properties, "Requested for") === meeting.attendees &&
    read.text(properties, "Research context").startsWith(prefix) &&
    read.select(properties, "Status") !== MEETING_STATUS.cancelled &&
    !read.checkbox(properties, "Regenerate prep")

  try {
    const reserved = await step(
      "Queue prep behind profile research",
      key("reserve-request"),
      async () => {
        const page = asPage(
          await notion.pages.retrieve({ page_id: meetingPageId })
        )
        if (isCurrent(page.properties)) return true
        // Do not overwrite a newer request or a changed/cancelled meeting.
        if (
          read.text(page.properties, "Research context") !==
            meeting.previousContext ||
          read.text(page.properties, "Attendee emails") !== meeting.attendees ||
          read.select(page.properties, "Status") === MEETING_STATUS.cancelled
        )
          return false
        await notion.pages.update({
          page_id: meetingPageId,
          properties: {
            "Prep status": prop.select(PREP_STATUS.queued),
            "Research status": { select: null },
            "Research context": prop.text(prefix),
            "Requested for": prop.text(meeting.attendees),
            "Regenerate prep": prop.checkbox(false),
          },
        })
        return true
      }
    )
    if (!reserved) return

    const contacts = await step(
      "Look up contacts",
      key("contacts"),
      async () => {
        try {
          const emails = splitEmails(meeting.attendees)
          return contactsByEmail(
            await calendar.listContacts({
              calendars: calendar.history,
              queries: emails,
            }),
            emails
          )
        } catch (error) {
          console.warn(`Contact lookup failed: ${(error as Error).message}`)
          return {} as Contacts
        }
      }
    )

    // Calendar history is best effort; absence of history is not proof that
    // no meetings occurred.
    const history = await step(
      "Find past meetings",
      key("past-meetings"),
      async () => {
        const emails = splitEmails(meeting.attendees)
        if (emails.length === 0) return {}
        try {
          const now = Date.now()
          const outputs: ListEventsScriptOutput[] = []
          for (
            let end = now;
            end > now - HISTORY_DAYS * DAY_MS;
            end -= LIST_EVENTS_DAYS * DAY_MS
          ) {
            const output = await calendar.listEvents({
              calendars: calendar.history,
              timeMin: new Date(end - LIST_EVENTS_DAYS * DAY_MS).toISOString(),
              timeMax: new Date(end).toISOString(),
              timeZone: TIME_ZONE,
            })
            outputs.push(output as ListEventsScriptOutput)
          }
          return pastMeetingsWith(outputs, emails, now, HISTORY_MEETINGS)
        } catch (error) {
          console.warn(
            `Past meeting lookup failed: ${(error as Error).message}`
          )
          return {} as Record<string, PastMeeting[]>
        }
      }
    )

    // Each check has its own durable key, so replay never reuses an earlier
    // pending snapshot. Waits release compute while profile agents work.
    let profiles: Awaited<ReturnType<typeof loadAttendees>>
    for (let attempt = 0; ; attempt += 1) {
      const checked = await step(
        "Check meeting profile research",
        key("check-profiles", String(attempt)),
        async () => {
          const page = asPage(
            await notion.pages.retrieve({ page_id: meetingPageId })
          )
          if (!isCurrent(page.properties)) return null
          return {
            ...(await loadAttendees(notion, targets, meeting.attendees)),
            timedOut: Date.now() - request.startedAt >= PROFILE_WAIT_MS,
          }
        }
      )
      if (!checked) return
      if (checked.failed.length)
        throw new Error(
          `Profile research failed for ${checked.failed.join(", ")}. Set those profiles to Ready, then retry Regenerate prep.`
        )
      if (!checked.pending.length) {
        profiles = checked
        break
      }
      if (checked.timedOut || attempt >= 40)
        throw new Error(
          `Still waiting for profile research after 20 minutes: ${checked.pending.join(", ")}. Check those profiles, then retry Regenerate prep.`
        )
      await context.wait.until("Wait for meeting profile research", {
        ...key("wait-profiles", String(attempt)),
        after: { seconds: 30 },
      })
    }
    const { attendees, companies } = profiles
    const contextText =
      prefix +
      researchPrompt(
        meeting,
        withKnownNames(attendees, contacts),
        companies,
        undefined, // Gmail is temporarily disabled; no mailbox is required.
        history
      )
    // Save all inputs before publishing Ready. The agent owns the result and
    // completion statuses; this workflow never starts or polls a session.
    const saved = await step(
      "Save research context",
      key("save-context"),
      async () => {
        const page = asPage(
          await notion.pages.retrieve({ page_id: meetingPageId })
        )
        if (!isCurrent(page.properties)) return false
        if (read.text(page.properties, "Research context") === contextText)
          return true
        await notion.pages.update({
          page_id: meetingPageId,
          properties: {
            "Research context": {
              rich_text: Array.from(
                { length: Math.ceil(contextText.length / 2000) },
                (_, i) => ({
                  text: {
                    content: contextText.slice(i * 2000, (i + 1) * 2000),
                  },
                })
              ),
            },
          },
        })
        return true
      }
    )
    if (!saved) return
    await step("Queue meeting research", key("queue-research"), async () => {
      // A replay after a successful API write must not requeue an agent that
      // already claimed or finished this request.
      const page = asPage(
        await notion.pages.retrieve({ page_id: meetingPageId })
      )
      const status = read.select(page.properties, "Research status")
      if (
        !isCurrent(page.properties) ||
        read.text(page.properties, "Research context") !== contextText
      )
        return null
      // The reservation cleared this status for this unique request. Any
      // value means it has already been handed off, even if the agent failed.
      if (status) return null
      await notion.pages.update({
        page_id: meetingPageId,
        properties: { "Research status": prop.select(RESEARCH_STATUS.ready) },
      })
      return null
    })
  } catch (error) {
    if (isRuntimeSignal(error)) throw error
    // Only unwatched properties change here, so a persistent failure does not
    // retrigger prep. Tick Regenerate prep to retry.
    await step("Mark failed", key("mark-failed"), async () => {
      const page = asPage(
        await notion.pages.retrieve({ page_id: meetingPageId })
      )
      if (
        !isCurrent(page.properties) ||
        read.select(page.properties, "Research status")
      )
        return null
      await notion.pages.update({
        page_id: meetingPageId,
        properties: {
          "Prep status": prop.select(PREP_STATUS.failed),
          "Research status": prop.select(RESEARCH_STATUS.failed),
          "Research context": prop.text(
            `${prefix}Preparation blocked: ${(error as Error).message}`
          ),
        },
      })
      return null
    })
    throw error
  }
}

async function loadAttendees(
  notion: Notion,
  targets: PrepTargets,
  attendeeEmails: string
): Promise<{
  attendees: Attendee[]
  companies: Company[]
  pending: string[]
  failed: string[]
}> {
  const attendees: Attendee[] = []
  const domains = new Set<string>()
  const pending: string[] = []
  const failed: string[] = []
  const check = async (page: ReturnType<typeof asPage>, label: string) => {
    const status = read.select(page.properties, "Research status")
    if (status === RESEARCH_STATUS.done) return
    if (status === RESEARCH_STATUS.failed) {
      failed.push(label)
      return
    }
    // Legacy profiles may have saved research without a status.
    if (!status && !needsResearch(page.properties)) return
    pending.push(label)
    if (needsResearch(page.properties)) await readyForResearch(notion, page.id)
  }
  for (const email of splitEmails(attendeeEmails)) {
    const page = await findOne(notion, targets.people, {
      property: "Email",
      email: { equals: email },
    })
    if (!page) {
      pending.push(email)
      continue
    }
    await check(page, email)
    const domain = read.text(page.properties, "Company domain")
    if (domain) domains.add(domain)
    attendees.push({
      id: page.id,
      name: read.title(page.properties, "Name"),
      email,
      role: read.text(page.properties, "Role"),
      photo: read.url(page.properties, "Photo"),
      companyDomain: domain || null,
      confidence: read.select(page.properties, "Confidence"),
      profiles: {
        linkedin: read.url(page.properties, PROFILE_PROPERTIES.linkedin),
        x: read.url(page.properties, PROFILE_PROPERTIES.x),
        instagram: read.url(page.properties, PROFILE_PROPERTIES.instagram),
        website: read.url(page.properties, PROFILE_PROPERTIES.website),
      },
    })
  }
  const companies: Company[] = []
  for (const domain of domains) {
    const page = await findOne(notion, targets.companies, {
      property: "Domain",
      rich_text: { equals: domain },
    })
    if (!page) {
      pending.push(domain)
      continue
    }
    await check(page, domain)
    companies.push({
      id: page.id,
      name: read.title(page.properties, "Name"),
      domain,
      summary: read.text(page.properties, "Summary"),
    })
  }
  return { attendees, companies, pending, failed }
}

export function splitEmails(value: string): string[] {
  return value
    .split(",")
    .map((email) => normalizeEmail(email))
    .filter(Boolean)
}

// Past meetings listed per attendee in the prompt; the People page lists more.
const PROMPT_PAST_MEETINGS = 5

// Bound the context stored on the meeting to keep agent input manageable.
export const MAX_PROMPT_CHARS = 9500
const MAX_AGENDA_CHARS = 1500

/** Attendees with the best name known before research: contacts, then email sender name. */
export function withKnownNames(
  attendees: readonly Attendee[],
  contacts: Contacts,
  threadsByAttendee: Record<string, readonly EmailThread[]> = {}
): Attendee[] {
  return attendees.map((attendee) => ({
    ...attendee,
    name:
      bestName(
        attendee.email,
        attendee.name,
        contacts[attendee.email]?.name,
        senderName(threadsByAttendee[attendee.email] ?? [], attendee.email)
      ) ?? attendee.name,
  }))
}

export function researchPrompt(
  meeting: Pick<MeetingSnapshot, "title" | "start" | "end" | "agenda">,
  attendees: readonly Attendee[],
  companies: readonly Company[],
  threadsByAttendee?: Record<string, readonly EmailThread[]>,
  pastMeetings: Record<string, readonly PastMeeting[]> = {}
): string {
  const companyByDomain = new Map(
    companies.map((company) => [company.domain, company])
  )
  const people = attendees
    .map((attendee) => {
      const company = attendee.companyDomain
        ? companyByDomain.get(attendee.companyDomain)
        : undefined
      // Placeholders derived from the email are not stated as facts, but are
      // passed as hints: the handle is often a first name to search with.
      const where = !company
        ? "personal email address"
        : company.name === companyNameFromDomain(company.domain)
          ? `company at ${company.domain} (name unconfirmed, likely "${company.name}")`
          : `${company.name} (${company.domain})`
      const handle = attendee.email.split("@")[0] ?? ""
      const low = attendee.confidence === CONFIDENCE.low
      const name = isPlaceholderName(attendee.name, attendee.email)
        ? `(full name unknown; email handle "${handle}")`
        : low
          ? `${attendee.name} (unconfirmed; email handle "${handle}")`
          : attendee.name
      const role = !attendee.role
        ? ""
        : low
          ? `, low-confidence role: ${attendee.role}`
          : `, known role: ${attendee.role}`
      const past = (pastMeetings[attendee.email] ?? []).slice(
        0,
        PROMPT_PAST_MEETINGS
      )
      const history =
        past.length === 0
          ? ""
          : `\n  Past meetings: ${past
              .map(
                (meeting) =>
                  `${meeting.start.slice(0, 10)} "${truncate(meeting.title, 80)}"`
              )
              .join("; ")}`
      const known = PROFILE_KEYS.flatMap((key) => attendee.profiles[key] ?? [])
      const profiles =
        known.length === 0 ? "" : `\n  Known profiles: ${known.join(", ")}`
      return `- ${name} <${attendee.email}>, ${where}${role}${profiles}${history}`
    })
    .join("\n")
  const emailContext =
    threadsByAttendee === undefined
      ? "Email research is temporarily disabled. Email was not checked; do not infer that no correspondence exists. Base recent interactions only on the supplied calendar history and linked meeting records."
      : ""
  const head = `Context for the meeting brief. Use current People and Companies profiles; the names and roles below are a snapshot, not confirmed research.
${emailContext}

## Meeting
Title: ${meeting.title}
When: ${meeting.start ?? "unknown"}${meeting.end ? ` to ${meeting.end}` : ""} (${TIME_ZONE})
Agenda / description:
${truncate(meeting.agenda, MAX_AGENDA_CHARS) || "(none)"}

## Outside attendees
${people}

${threadsByAttendee === undefined ? "" : `## Recent email threads (last ${EMAIL_LOOKBACK_DAYS} days, newest first)`}
`
  if (threadsByAttendee === undefined) return truncate(head, MAX_PROMPT_CHARS)
  // Add threads newest first until the prompt would exceed the API limit.
  let body = ""
  let omitted = 0
  for (const line of emailLines(threadsByAttendee)) {
    if (head.length + body.length + line.length + 1 > MAX_PROMPT_CHARS - 80)
      omitted += 1
    else body += `${line}\n`
  }
  if (!body) body = "(no email with these attendees)\n"
  if (omitted > 0) body += `(${omitted} older threads omitted)\n`
  return truncate(head + body, MAX_PROMPT_CHARS)
}
