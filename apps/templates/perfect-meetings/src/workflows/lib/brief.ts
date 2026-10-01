export const PREP_HEADING = "## Meeting prep"
export const NOTES_HEADING = "## Notes"
export const PROFILE_HEADING = "## Profile"

/** Public profile URLs, as found by the researcher. */
export type Profiles = {
  linkedin: string | null
  x: string | null
  instagram: string | null
  website: string | null
}

export type Brief = {
  company: string
  role: string
  emails: string
  objective: string
  people: Array<{
    email: string
    name: string
    role: string
    roleSource: string | null
    /** The researcher matched this person on partial evidence, such as a first name. */
    lowConfidence: boolean
    /** Their role and responsibilities, for the People page. */
    responsibilities: string
    /** Recent email and meetings with them, for the People page. */
    interactions: string
    profiles: Profiles
  }>
  companies: Array<{ domain: string; name: string; summary: string }>
}

/** Unwrap a Markdown link the agent may add, e.g. "[acme.com](http://acme.com)". */
function unlink(value: string): string {
  return value
    .trim()
    .replace(/^\[([^\]]*)\]\([^)]*\)$/, "$1")
    .trim()
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/** An http(s) URL, taken from a Markdown link's target when the agent wraps it. */
function httpUrl(value: unknown): string | null {
  const raw = str(value)
  const url = raw.match(/^\[[^\]]*\]\(([^)]*)\)$/)?.[1]?.trim() ?? raw
  return /^https?:\/\//.test(url) ? url : null
}

// Hosts each profile URL must be on, so a link is never filed under the wrong
// network. A personal site may be anywhere except those networks.
const PROFILE_HOSTS = {
  linkedin: /(^|\.)linkedin\.com$/,
  x: /(^|\.)(x|twitter)\.com$/,
  instagram: /(^|\.)instagram\.com$/,
} as const

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ""
  }
}

function profiles(value: unknown): Profiles {
  const raw =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {}
  const on = (key: keyof typeof PROFILE_HOSTS) => {
    const url = httpUrl(raw[key])
    return url && PROFILE_HOSTS[key].test(hostOf(url)) ? url : null
  }
  const site = httpUrl(raw.website)
  const social = Object.values(PROFILE_HOSTS)
  return {
    linkedin: on("linkedin"),
    x: on("x"),
    instagram: on("instagram"),
    website:
      site && !social.some((host) => host.test(hostOf(site))) ? site : null,
  }
}

/** Parse the researcher's JSON reply, tolerating code fences or surrounding prose. */
export function parseBrief(reply: string): Brief {
  const start = reply.indexOf("{")
  const end = reply.lastIndexOf("}")
  if (start === -1 || end <= start)
    throw new Error("Researcher reply did not contain JSON")
  const raw: unknown = JSON.parse(reply.slice(start, end + 1))
  if (typeof raw !== "object" || raw === null)
    throw new Error("Researcher reply was not an object")
  const value = raw as Record<string, unknown>
  const text = (key: string) =>
    typeof value[key] === "string" ? (value[key] as string).trim() : ""
  const list = (key: string) =>
    Array.isArray(value[key]) ? (value[key] as unknown[]) : []
  const brief: Brief = {
    company: text("company"),
    role: text("role"),
    emails: text("emails"),
    objective: text("objective"),
    people: list("people").flatMap((item) => {
      const person = item as Record<string, unknown>
      return typeof person.email === "string" && typeof person.role === "string"
        ? [
            {
              email: unlink(person.email).toLowerCase(),
              name: typeof person.name === "string" ? person.name.trim() : "",
              role: person.role.trim(),
              roleSource: httpUrl(person.roleSource),
              lowConfidence: person.confidence === "low",
              responsibilities: str(person.responsibilities),
              interactions: str(person.interactions),
              profiles: profiles(person.profiles),
            },
          ]
        : []
    }),
    companies: list("companies").flatMap((item) => {
      const company = item as Record<string, unknown>
      return typeof company.domain === "string"
        ? [
            {
              domain: unlink(company.domain).toLowerCase(),
              name: typeof company.name === "string" ? company.name.trim() : "",
              summary:
                typeof company.summary === "string"
                  ? company.summary.trim()
                  : "",
            },
          ]
        : []
    }),
  }
  if (!brief.company && !brief.role && !brief.emails && !brief.objective) {
    throw new Error("Researcher reply had no brief sections")
  }
  return brief
}

function paragraph(value: string): string {
  // Keep each section a single paragraph so headings stay intact.
  return value.replace(/\s*\n+\s*/g, " ").trim() || "_No information found._"
}

export function briefMarkdown(brief: Brief, updatedLabel: string): string {
  return [
    PREP_HEADING,
    `_Updated ${updatedLabel}_`,
    "### Company",
    paragraph(brief.company),
    "### Who you're meeting",
    paragraph(brief.role),
    "### Recent email",
    paragraph(brief.emails),
    "### Objective and agenda",
    paragraph(brief.objective),
    "---",
  ].join("\n")
}

export type BodyEdit =
  | { type: "insert"; content: string }
  | { type: "replace"; oldStr: string; newStr: string }

/**
 * Decide how to write a managed section, such as the meeting brief or a
 * person's profile, into the page body. An existing section (from its heading
 * up to the Notes heading) is replaced; otherwise the section and a Notes
 * heading are inserted at the top. Anything under Notes
 * is left alone.
 */
export function planBodyEdit(
  existing: string,
  brief: string,
  heading: string = PREP_HEADING
): BodyEdit {
  const prepAt = existing.indexOf(heading)
  if (prepAt !== -1) {
    const notesAt = existing.indexOf(NOTES_HEADING, prepAt)
    if (notesAt !== -1) {
      const oldStr = existing.slice(prepAt, notesAt).trimEnd()
      return { type: "replace", oldStr, newStr: brief }
    }
  }
  return { type: "insert", content: `${brief}\n${NOTES_HEADING}\n` }
}

/** What a People page profile is built from. */
export type ProfileInput = {
  /** The accepted research match, or undefined when there is none. */
  researched: Brief["people"][number] | undefined
  lowConfidence: boolean
  meetings: ReadonlyArray<{
    title: string
    start: string
    /** The Meetings page, else the calendar event. */
    url: string | null
  }>
  lookbackDays: number
  timeZone: string
}

function meetingDate(start: string, timeZone: string): string {
  // All-day dates are calendar dates; format them without shifting zones.
  if (start.length === 10) {
    const [y, m, d] = start.split("-").map(Number) as [number, number, number]
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
      timeZone: "UTC",
      dateStyle: "medium",
    })
  }
  return new Date(start).toLocaleDateString("en-US", {
    timeZone,
    dateStyle: "medium",
  })
}

/** A URL, or text containing URLs, without scheme, "www.", or trailing slash. */
function bareUrl(value: string): string {
  return value.replace(/https?:\/\/(www\.)?/g, "").replace(/\/(?=[)\s]|$)/g, "")
}

/** Escape text for a Markdown link label. */
function label(value: string): string {
  return value.replace(/([[\]])/g, "\\$1")
}

export function profileMarkdown(
  input: ProfileInput,
  updatedLabel: string
): string {
  const { researched } = input
  const lines = [PROFILE_HEADING, `_Updated ${updatedLabel}_`]
  if (researched && input.lowConfidence)
    lines.push(
      '<callout icon="⚠️" color="yellow_bg">Low-confidence match: the researcher matched only part of this person\'s name. Check before relying on this.</callout>'
    )
  lines.push("### Role and responsibilities")
  const responsibilities = paragraph(researched?.responsibilities ?? "")
  const source = researched?.roleSource
  // The agent often cites the same page inline; link it only once.
  lines.push(
    source && !bareUrl(responsibilities).includes(bareUrl(source))
      ? `${responsibilities} ([source](${source}))`
      : responsibilities
  )
  lines.push("### Recent meetings")
  if (input.meetings.length === 0)
    lines.push(`_No meetings in the last ${input.lookbackDays} days._`)
  for (const meeting of input.meetings) {
    const date = meetingDate(meeting.start, input.timeZone)
    lines.push(
      meeting.url
        ? `- ${date} · [${label(meeting.title)}](${meeting.url})`
        : `- ${date} · ${meeting.title}`
    )
  }
  lines.push(
    "### Recent communication",
    paragraph(researched?.interactions ?? "")
  )
  lines.push("---")
  return lines.join("\n")
}
