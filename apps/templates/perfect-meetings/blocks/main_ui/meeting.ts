import type {
  NotionPage,
  NotionPagePropertyValue,
} from "@notionhq/apps/custom-blocks"

// Pure helpers for picking and describing the current or next meeting.

export type PageRow<Id extends string = string> = {
  id: Id
  getPropertyByKey: NotionPage["getPropertyByKey"]
  created_time: string | null
  last_edited_time: string | null
}

const HOUR_MS = 60 * 60 * 1000

function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant))
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value)
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  )
  return asUtc - Math.floor(instant / 1000) * 1000
}

/** Convert a wall-clock date and time in a zone (UTC when absent) to epoch ms. */
export function wallTimeToMs(
  date: string,
  time: string,
  timeZone?: string
): number {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time)
  const year = Number(dateMatch?.[1])
  const month = Number(dateMatch?.[2])
  const day = Number(dateMatch?.[3])
  const hour = Number(timeMatch?.[1])
  const minute = Number(timeMatch?.[2])
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  if (!timeZone) return guess
  return guess - zoneOffsetMs(guess - zoneOffsetMs(guess, timeZone), timeZone)
}

function localMidnightMs(date: string): number {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const year = Number(dateMatch?.[1])
  const month = Number(dateMatch?.[2])
  const day = Number(dateMatch?.[3])
  return new Date(year, month - 1, day).getTime()
}

/** Start and end of a date value in epoch ms. Meetings without an end last an hour. */
export function dateRange(
  property: NotionPagePropertyValue | null
): { startMs: number; endMs: number; allDay: boolean } | null {
  if (property?.type !== "date" || property.date === null) return null
  const date = property.date
  const allDay = !date.start.includes("T")
  const startMs = parseNotionDate(date.start, date.time_zone, allDay)
  if (startMs === null) return null
  if (allDay) {
    const endMidnight = date.end
      ? parseNotionDate(date.end, date.time_zone, true)
      : localMidnightMs(date.start)
    const endMs = endMidnight === null ? null : nextLocalMidnight(endMidnight)
    if (endMs === null) return null
    return { startMs, endMs, allDay: true }
  }
  const endMs = date.end
    ? parseNotionDate(date.end, date.time_zone, false)
    : startMs + HOUR_MS
  if (endMs === null) return null
  return { startMs, endMs, allDay: false }
}

function parseNotionDate(
  value: string,
  timeZone: string | null | undefined,
  allDay: boolean
): number | null {
  if (allDay) return localMidnightMs(value)
  if (!value.includes("T")) return null
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const instant = Date.parse(value)
    return Number.isFinite(instant) ? instant : null
  }
  const time = value.slice(11, 16)
  if (time.length !== 5) return null
  return wallTimeToMs(value.slice(0, 10), time, timeZone ?? undefined)
}

function nextLocalMidnight(midnight: number): number {
  const next = new Date(midnight)
  next.setDate(next.getDate() + 1)
  return next.getTime()
}

export function splitEmails(value: string): string[] {
  return value
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
}

export function text(
  value: NotionPagePropertyValue | null | undefined
): string {
  if (!value) return ""
  if (value.type === "title") {
    return value.title
      .map((segment) => segment["plain_text"])
      .filter((part): part is string => typeof part === "string")
      .join("")
  }
  if (value.type === "rich_text") {
    return value.rich_text
      .map((segment) => segment["plain_text"])
      .filter((part): part is string => typeof part === "string")
      .join("")
  }
  if (value.type === "select") {
    return value.select?.name ?? ""
  }
  if (value.type === "status") {
    return value.status?.name ?? ""
  }
  if (value.type === "url") {
    return value.url ?? ""
  }
  if (value.type === "email") {
    return value.email ?? ""
  }
  if (value.type === "phone_number") {
    return value.phone_number ?? ""
  }
  return ""
}

/** Rows ordered by start time, dropping duplicates by ID. */
export function sortByStart<Row extends PageRow>(rows: readonly Row[]): Row[] {
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()]
  const start = (row: Row) =>
    dateRange(row.getPropertyByKey("When"))?.startMs ?? Infinity
  return unique.sort((a, b) => start(a) - start(b))
}

/**
 * The meeting in progress, or else the next one to start. A timed meeting in
 * progress wins over an all-day or multi-day event in progress (such as an
 * offsite), which wins over anything upcoming. Rows arrive sorted by start.
 */
export function pickMeeting<Row extends PageRow>(
  rows: readonly Row[],
  now: number
): {
  row: Row
  startMs: number
  endMs: number
  allDay: boolean
} | null {
  let allDayNow: {
    row: Row
    startMs: number
    endMs: number
    allDay: boolean
  } | null = null
  let upcoming: {
    row: Row
    startMs: number
    endMs: number
    allDay: boolean
  } | null = null
  for (const row of rows) {
    const range = dateRange(row.getPropertyByKey("When"))
    if (!range || range.endMs <= now) continue
    const candidate = { row, ...range }
    if (range.startMs <= now) {
      if (!range.allDay) return candidate
      allDayNow ??= candidate
    } else {
      upcoming ??= candidate
    }
  }
  return allDayNow ?? upcoming
}

const PROFILE_LINKS = [
  ["LinkedIn", "LinkedIn"],
  ["X", "X"],
  ["Instagram", "Instagram"],
  ["Personal site", "Website"],
] as const

/** A person's public profile links that are set, in a fixed order. */
export function profileLinks(page: PageRow): { label: string; url: string }[] {
  return PROFILE_LINKS.flatMap(([property, label]) => {
    const url = text(page.getPropertyByKey(property))
    return /^https?:\/\//.test(url) ? [{ label, url }] : []
  })
}

/** A person card's role line, marked when People Confidence is Low. */
export function roleLabel(role: string, confidence: string): string {
  if (!role) return ""
  return confidence === "Low" ? `(low confidence) ${role}` : role
}

export function firstSentence(value: string): string {
  const match = value.match(/^.*?[.!?](\s|$)/)
  return (match ? match[0] : value).trim()
}

type Ranged<Row extends PageRow> = {
  row: Row
  startMs: number
  endMs: number
  allDay: boolean
}

/** Local midnight at the start of the day containing `now`, and the next one. */
export function dayBounds(now: number): { startMs: number; endMs: number } {
  const day = new Date(now)
  const startMs = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate()
  ).getTime()
  const endMs = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate() + 1
  ).getTime()
  return { startMs, endMs }
}

/** A timed meeting placed in a day column, sharing width with overlaps. */
export type DayEvent<Row extends PageRow = PageRow> = Ranged<Row> & {
  /** Visible start and end, clipped to the day. */
  topMs: number
  bottomMs: number
  column: number
  columns: number
}

const MIN_EVENT_MS = 15 * 60 * 1000

/**
 * Meetings that touch the day. All-day events, and timed events that span the
 * whole day, go on the all-day strip. Timed events are laid out like a
 * calendar day: overlapping events split the width into columns.
 */
export function layoutDay<Row extends PageRow>(
  rows: readonly Row[],
  day: { startMs: number; endMs: number }
): { allDay: Ranged<Row>[]; timed: DayEvent<Row>[] } {
  const allDay: Ranged<Row>[] = []
  const timed: Omit<DayEvent<Row>, "column" | "columns">[] = []
  for (const row of sortByStart(rows)) {
    const range = dateRange(row.getPropertyByKey("When"))
    if (!range || range.endMs <= day.startMs || range.startMs >= day.endMs)
      continue
    const candidate = { row, ...range }
    if (
      range.allDay ||
      (range.startMs <= day.startMs && range.endMs >= day.endMs)
    ) {
      allDay.push(candidate)
      continue
    }
    const topMs = Math.max(range.startMs, day.startMs)
    const bottomMs = Math.max(
      Math.min(range.endMs, day.endMs),
      Math.min(topMs + MIN_EVENT_MS, day.endMs)
    )
    timed.push({ ...candidate, topMs, bottomMs })
  }

  // Group chains of overlapping events, then give each event the first free
  // column in its group. Every event in a group shares the group's width.
  const placed: DayEvent<Row>[] = []
  let group: DayEvent<Row>[] = []
  let groupEnd = -Infinity
  const flush = () => {
    const columns = Math.max(1, ...group.map((event) => event.column + 1))
    for (const event of group) placed.push({ ...event, columns })
    group = []
  }
  for (const event of timed.sort((a, b) => a.topMs - b.topMs)) {
    if (event.topMs >= groupEnd) {
      flush()
      groupEnd = -Infinity
    }
    let column = 0
    while (
      group.some(
        (other) => other.column === column && other.bottomMs > event.topMs
      )
    )
      column++
    group.push({ ...event, column, columns: 1 })
    groupEnd = Math.max(groupEnd, event.bottomMs)
  }
  flush()
  return { allDay, timed: placed }
}

/**
 * The distinct companies of a meeting's attendees, in attendee order, each
 * with the attendees who work there.
 */
export function groupByCompany<T>(
  attendees: readonly T[],
  domainOf: (attendee: T) => string
): { domain: string; attendees: T[] }[] {
  const groups = new Map<string, T[]>()
  for (const attendee of attendees) {
    const domain = domainOf(attendee).trim().toLowerCase()
    if (!domain) continue
    const members = groups.get(domain) ?? []
    members.push(attendee)
    groups.set(domain, members)
  }
  return [...groups].map(([domain, members]) => ({
    domain,
    attendees: members,
  }))
}
