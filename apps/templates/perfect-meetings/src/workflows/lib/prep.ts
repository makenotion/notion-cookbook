import type { WorkflowContext } from "@notionhq/apps"
import { connections } from "@notionhq/apps/workflow"

import {
  EMAIL_LOOKBACK_DAYS,
  EMAIL_THREADS_PER_ATTENDEE,
  TIME_ZONE,
} from "../../lib/config.js"
import {
  bestName,
  companyNameFromDomain,
  isPlaceholderName,
  normalizeEmail,
} from "../../lib/domains.js"
import {
  asPage,
  findOne,
  prop,
  read,
  type Notion,
  type PropertyMap,
} from "../../lib/props.js"
import { MEETING_STATUS, PREP_STATUS } from "../../notion.js"
import { briefMarkdown, parseBrief, planBodyEdit, type Brief } from "./brief.js"
import {
  emailLines,
  parseThreads,
  relevantThreads,
  senderName,
  type EmailThread,
} from "./email.js"
import { pickBusinessAccount, truncate } from "./calendar.js"
import { contactsByEmail, type ContactInfo, type Contacts } from "./ingest.js"
import { isRuntimeSignal } from "./runtime.js"

export const prepConnections = {
  calendar: connections.calendar({
    scope: "read",
    readTeammatesCalendars: false,
  }),
  mail: connections.mail(),
}

type PrepContext = Pick<
  WorkflowContext<typeof prepConnections>,
  "step" | "wait" | "notion" | "connections"
>

export type PrepReason = "created" | "updated" | "morning" | "force"

const POLL_SECONDS = 15
const MAX_POLLS = 40 // 10 minutes
const TERMINAL = new Set([
  "completed",
  "failed",
  "canceled",
  "terminated",
  "requires_action",
])

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
}

export type Attendee = {
  id: string
  name: string
  email: string
  role: string
  photo: string | null
  companyDomain: string | null
}
export type Company = {
  id: string
  name: string
  domain: string
  summary: string
}

/** Decide whether a trigger should (re)write the brief. */
export function shouldPrep(
  reason: PrepReason,
  meeting: MeetingSnapshot
): boolean {
  if (meeting.status === MEETING_STATUS.cancelled) return false
  if (meeting.attendees === "") return false
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

export type PrepTargets = { agentId: string; people: string; companies: string }

export function prepTargets(access: {
  researcher: { id: string }
  people: { id: string }
  companies: { id: string }
}): PrepTargets {
  return {
    agentId: access.researcher.id,
    people: access.people.id,
    companies: access.companies.id,
  }
}

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
    } satisfies MeetingSnapshot
  })
  if (!shouldPrep(reason, meeting)) return

  await step("Mark researching", key("mark-researching"), () =>
    notion.pages
      .update({
        page_id: meetingPageId,
        properties: { "Prep status": prop.select(PREP_STATUS.researching) },
      })
      .then(() => null)
  )

  try {
    const { attendees, companies } = await step(
      "Load attendees",
      key("load-attendees"),
      () => loadAttendees(notion, targets, meeting.attendees)
    )

    const mailbox = await step(
      "Find mailbox",
      key("find-mailbox"),
      async () => {
        const { accounts } = await context.connections.calendar.listCalendars(
          {}
        )
        const email = pickBusinessAccount(accounts)?.email
        if (!email)
          throw new Error(
            "No calendar account email found for the Gmail search"
          )
        return email
      }
    )

    const contacts = await step(
      "Look up contacts",
      key("contacts"),
      async () => {
        try {
          const emails = attendees.map((attendee) => attendee.email)
          return contactsByEmail(
            await context.connections.calendar.listContacts({
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

    const excerpts: Record<string, EmailThread[]> = {}
    for (const attendee of attendees) {
      excerpts[attendee.email] = await step(
        "Search email",
        key("email", attendee.email),
        () => searchEmail(context, mailbox, attendee.email)
      )
    }

    const sessionId = await step(
      "Start research",
      key("start-research"),
      async () => {
        const session = await notion.sessions.update({
          agent_id: targets.agentId,
          message: researchPrompt(
            meeting,
            withKnownNames(attendees, contacts, excerpts),
            companies,
            excerpts
          ),
        })
        return session.id
      }
    )

    let status = "queued"
    for (let poll = 0; poll < MAX_POLLS && !TERMINAL.has(status); poll++) {
      await context.wait.until("Wait for research", {
        ...key("research-wait", String(poll)),
        after: { seconds: POLL_SECONDS },
      })
      status = await step(
        "Check research",
        key("research-status", String(poll)),
        async () => {
          const session = await notion.sessions.retrieve({
            session_id: sessionId,
          })
          return session.status
        }
      )
    }
    if (status !== "completed")
      throw new Error(`Research session ended with status "${status}"`)

    const reply = await step("Read research", key("read-research"), () =>
      lastAgentMessage(notion, sessionId)
    )
    const brief = parseBrief(reply)

    await step("Write brief", key("write-brief"), () =>
      writeBrief(notion, meetingPageId, brief)
    )

    for (const attendee of attendees) {
      const properties = personUpdates(
        attendee,
        brief,
        excerpts[attendee.email] ?? [],
        contacts[attendee.email]
      )
      if (Object.keys(properties).length > 0) {
        await step("Save person", key("person", attendee.id), () =>
          notion.pages
            .update({ page_id: attendee.id, properties })
            .then(() => null)
        )
      }
    }
    for (const company of companies) {
      const found = matchCompany(company, companies.length, brief)
      const properties: PropertyMap = {}
      if (found?.summary && !company.summary)
        properties.Summary = prop.text(found.summary)
      if (
        found?.name &&
        company.name === companyNameFromDomain(company.domain)
      ) {
        properties.Name = prop.title(found.name)
      }
      if (Object.keys(properties).length > 0) {
        await step("Save company", key("company", company.id), () =>
          notion.pages
            .update({ page_id: company.id, properties })
            .then(() => null)
        )
      }
    }

    await step("Mark ready", key("mark-ready"), () =>
      notion.pages
        .update({
          page_id: meetingPageId,
          properties: {
            "Prep status": prop.select(PREP_STATUS.ready),
            "Prep updated": prop.date(new Date().toISOString()),
            "Prepped for": prop.text(meeting.attendees),
            "Regenerate prep": prop.checkbox(false),
          },
        })
        .then(() => null)
    )
  } catch (error) {
    if (isRuntimeSignal(error)) throw error
    // Only unwatched properties change here, so a persistent failure does not
    // retrigger prep. Tick Regenerate prep to retry.
    await step("Mark failed", key("mark-failed"), () =>
      notion.pages
        .update({
          page_id: meetingPageId,
          properties: { "Prep status": prop.select(PREP_STATUS.failed) },
        })
        .then(() => null)
    )
    throw error
  }
}

/**
 * Role, name, and photo updates for a person. A name replaces only the
 * email-derived placeholder, preferring contacts, then the attendee's own
 * email sender name, then the agent's guess.
 */
export function personUpdates(
  attendee: Attendee,
  brief: Brief,
  threads: readonly EmailThread[],
  contact?: ContactInfo
): PropertyMap {
  const properties: PropertyMap = {}
  if (contact?.photoUrl && !attendee.photo)
    properties.Photo = prop.url(contact.photoUrl)
  const researched = brief.people.find(
    (person) => person.email === attendee.email
  )
  if (researched?.role && !attendee.role) {
    properties.Role = prop.text(researched.role)
    if (researched.roleSource)
      properties["Role source"] = prop.url(researched.roleSource)
  }
  if (isPlaceholderName(attendee.name, attendee.email)) {
    const name = bestName(
      attendee.email,
      contact?.name,
      senderName(threads, attendee.email),
      researched?.name
    )
    if (name) properties.Name = prop.title(name)
  }
  return properties
}

/**
 * The researched company for a stored one: by domain, else the only company
 * when both sides have exactly one (the agent may use the company's public web
 * domain rather than its email domain).
 */
export function matchCompany(
  company: Pick<Company, "domain">,
  storedCount: number,
  brief: Pick<Brief, "companies">
): Brief["companies"][number] | undefined {
  const byDomain = brief.companies.find(
    (candidate) => candidate.domain === company.domain
  )
  if (byDomain) return byDomain
  return storedCount === 1 && brief.companies.length === 1
    ? brief.companies[0]
    : undefined
}

async function loadAttendees(
  notion: Notion,
  targets: PrepTargets,
  attendeeEmails: string
): Promise<{ attendees: Attendee[]; companies: Company[] }> {
  const attendees: Attendee[] = []
  const domains = new Set<string>()
  for (const email of splitEmails(attendeeEmails)) {
    const page = await findOne(notion, targets.people, {
      property: "Email",
      email: { equals: email },
    })
    if (!page) continue
    const domain = read.text(page.properties, "Company domain")
    if (domain) domains.add(domain)
    attendees.push({
      id: page.id,
      name: read.title(page.properties, "Name"),
      email,
      role: read.text(page.properties, "Role"),
      photo: read.url(page.properties, "Photo"),
      companyDomain: domain || null,
    })
  }
  const companies: Company[] = []
  for (const domain of domains) {
    const page = await findOne(notion, targets.companies, {
      property: "Domain",
      rich_text: { equals: domain },
    })
    if (!page) continue
    companies.push({
      id: page.id,
      name: read.title(page.properties, "Name"),
      domain,
      summary: read.text(page.properties, "Summary"),
    })
  }
  return { attendees, companies }
}

export function splitEmails(value: string): string[] {
  return value
    .split(",")
    .map((email) => normalizeEmail(email))
    .filter(Boolean)
}

async function searchEmail(
  context: PrepContext,
  mailbox: string,
  email: string
): Promise<EmailThread[]> {
  const result = await context.connections.mail.searchEmails({
    userEmailAddress: mailbox,
    query: `{from:${email} to:${email} cc:${email}} newer_than:${EMAIL_LOOKBACK_DAYS}d`,
    count: EMAIL_THREADS_PER_ATTENDEE,
  })
  if (result.isError)
    throw new Error(
      `Gmail search failed for an attendee (code ${result.toolErrorCode ?? "unknown"})`
    )
  const threads =
    parseThreads(result.structuredContent) ?? parseThreads(result.content)
  if (!threads) {
    console.warn(
      "Gmail search returned an unrecognised shape; continuing without email for this attendee"
    )
    return []
  }
  return relevantThreads(threads, email, mailbox)
}

// The sessions API rejects messages over 10,000 characters.
export const MAX_PROMPT_CHARS = 9500
const MAX_AGENDA_CHARS = 1500

/** Attendees with the best name known before research: contacts, then email sender name. */
export function withKnownNames(
  attendees: readonly Attendee[],
  contacts: Contacts,
  threadsByAttendee: Record<string, readonly EmailThread[]>
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
  threadsByAttendee: Record<string, readonly EmailThread[]>
): string {
  const companyByDomain = new Map(
    companies.map((company) => [company.domain, company])
  )
  const people = attendees
    .map((attendee) => {
      const company = attendee.companyDomain
        ? companyByDomain.get(attendee.companyDomain)
        : undefined
      // Placeholders derived from the email would mislead web searches.
      const where = !company
        ? "personal email address"
        : company.name === companyNameFromDomain(company.domain)
          ? `company at ${company.domain} (name unknown)`
          : `${company.name} (${company.domain})`
      const name = isPlaceholderName(attendee.name, attendee.email)
        ? "(full name unknown)"
        : attendee.name
      return `- ${name} <${attendee.email}>, ${where}${attendee.role ? `, known role: ${attendee.role}` : ""}`
    })
    .join("\n")
  const head = `Write the pre-meeting brief for this meeting. Reply with the JSON object described in your instructions.

## Meeting
Title: ${meeting.title}
When: ${meeting.start ?? "unknown"}${meeting.end ? ` to ${meeting.end}` : ""} (${TIME_ZONE})
Agenda / description:
${truncate(meeting.agenda, MAX_AGENDA_CHARS) || "(none)"}

## Outside attendees
${people}

## Recent email threads (last ${EMAIL_LOOKBACK_DAYS} days, newest first)
`
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

type SessionEvent = Awaited<
  ReturnType<Notion["sessions"]["queryEvents"]>
>["results"][number]

/** The text of the highest-sequence agent message in a list of session events. */
export function lastAgentText(events: readonly SessionEvent[]): string | null {
  let best: { sequence: number; text: string } | null = null
  for (const event of events) {
    if (event.type !== "agent.message") continue
    const text = event.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("")
    if (text && (!best || event.sequence > best.sequence))
      best = { sequence: event.sequence, text }
  }
  return best?.text ?? null
}

async function lastAgentMessage(
  notion: Notion,
  sessionId: string
): Promise<string> {
  // Read every event rather than relying on a server-side type filter,
  // which did not narrow results in a live run.
  const events: SessionEvent[] = []
  let cursor: string | undefined
  do {
    const response = await notion.sessions.queryEvents({
      session_id: sessionId,
      sorts: [{ property: "sequence", direction: "ascending" }],
      start_cursor: cursor,
      page_size: 100,
    })
    events.push(...response.results)
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
  } while (cursor)
  const text = lastAgentText(events)
  if (!text) throw new Error("Research session produced no reply")
  return text
}

async function writeBrief(
  notion: Notion,
  pageId: string,
  brief: Brief
): Promise<null> {
  const updated = new Date().toLocaleString("en-US", {
    timeZone: TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short",
  })
  const markdown = briefMarkdown(brief, updated)
  const current = await notion.pages.retrieveMarkdown({ page_id: pageId })
  const edit = planBodyEdit(current.markdown, markdown)
  if (edit.type === "replace") {
    await notion.pages.updateMarkdown({
      page_id: pageId,
      type: "update_content",
      update_content: {
        content_updates: [{ old_str: edit.oldStr, new_str: edit.newStr }],
        allow_deleting_content: true,
      },
    })
  } else {
    await notion.pages.updateMarkdown({
      page_id: pageId,
      type: "insert_content",
      insert_content: { content: edit.content, position: { type: "start" } },
    })
  }
  return null
}
