import type {
  NotionDataSourcePage,
  NotionDataSourceValue,
} from "@notionhq/apps/custom-blocks"

// Pure helpers for picking and describing the current or next meeting.

type DateValue = {
  type: "date" | "daterange" | "datetime" | "datetimerange"
  start_date: string
  start_time?: string
  end_date?: string
  end_time?: string
  time_zone?: string
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
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ]
  const [hour, minute] = time.split(":").map(Number) as [number, number]
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  if (!timeZone) return guess
  return guess - zoneOffsetMs(guess - zoneOffsetMs(guess, timeZone), timeZone)
}

function localMidnightMs(date: string): number {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ]
  return new Date(year, month - 1, day).getTime()
}

/** Start and end of a date value in epoch ms. Meetings without an end last an hour. */
export function dateRange(
  value: unknown
): { startMs: number; endMs: number; allDay: boolean } | null {
  if (typeof value !== "object" || value === null || !("start_date" in value))
    return null
  const date = value as DateValue
  if (date.type === "date" || date.type === "daterange") {
    const startMs = localMidnightMs(date.start_date)
    const endMs =
      localMidnightMs(date.end_date ?? date.start_date) + 24 * HOUR_MS
    return { startMs, endMs, allDay: true }
  }
  const startMs = wallTimeToMs(
    date.start_date,
    date.start_time ?? "00:00",
    date.time_zone
  )
  const endMs =
    date.end_date && date.end_time
      ? wallTimeToMs(date.end_date, date.end_time, date.time_zone)
      : startMs + HOUR_MS
  return { startMs, endMs, allDay: false }
}

export function splitEmails(value: string): string[] {
  return value
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
}

export function text(value: NotionDataSourceValue | undefined): string {
  return typeof value === "string" ? value : ""
}

/** Rows ordered by start time, dropping duplicates by ID. */
export function sortByStart(
  rows: readonly NotionDataSourcePage[]
): NotionDataSourcePage[] {
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()]
  const start = (row: NotionDataSourcePage) =>
    dateRange(row.propertiesByKey.When)?.startMs ?? Infinity
  return unique.sort((a, b) => start(a) - start(b))
}

/**
 * The meeting in progress, or else the next one to start. A timed meeting in
 * progress wins over an all-day or multi-day event in progress (such as an
 * offsite), which wins over anything upcoming. Rows arrive sorted by start.
 */
export function pickMeeting(
  rows: readonly NotionDataSourcePage[],
  now: number
): {
  row: NotionDataSourcePage
  startMs: number
  endMs: number
  allDay: boolean
} | null {
  let allDayNow: ReturnType<typeof pickMeeting> = null
  let upcoming: ReturnType<typeof pickMeeting> = null
  for (const row of rows) {
    const range = dateRange(row.propertiesByKey.When)
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

export function firstSentence(value: string): string {
  const match = value.match(/^.*?[.!?](\s|$)/)
  return (match ? match[0] : value).trim()
}
