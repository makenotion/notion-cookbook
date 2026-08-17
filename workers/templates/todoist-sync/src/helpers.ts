// Shared, deterministic transforms for Todoist values before they reach a
// managed Notion database.

import { createHash } from "node:crypto"

import * as Builder from "@notionhq/workers/builder"

const MAX_RICH_TEXT_CHARACTERS = 2_000
const MAX_OPTION_NAME_CHARACTERS = 100
const MAX_MULTI_SELECT_OPTIONS = 100

type DueStatus = "Overdue" | "Today" | "Next 7 days" | "Later" | "No due date"

type DueClassification = {
  status: DueStatus
  sortKey?: string
  dueNextSevenDays: boolean
}

type DueValue = {
  date: string | null
}

export function boundedText(
  value: string | null | undefined,
  maximum = MAX_RICH_TEXT_CHARACTERS
): string | null {
  const normalized = value?.trim()
  if (!normalized) return null

  const characters = Array.from(normalized)
  return characters.length <= maximum
    ? normalized
    : characters.slice(0, maximum).join("")
}

/** Make provider-authored values safe and deterministic as Notion options. */
export function optionLabel(value: string | null | undefined): string | null {
  const normalized = value?.normalize("NFKC").trim().replace(/\s+/gu, " ")
  if (!normalized) return null

  // ASCII commas delimit multi-select values in the Worker builder.
  const safe = normalized.replace(/,/gu, "，")
  const characters = Array.from(safe)
  if (characters.length <= MAX_OPTION_NAME_CHARACTERS) return safe

  const digest = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 8)
  const suffix = `… ${digest}`
  const prefixLength = MAX_OPTION_NAME_CHARACTERS - Array.from(suffix).length
  return `${characters.slice(0, prefixLength).join("")}${suffix}`
}

export function optionLabels(
  property: string,
  values: ReadonlyArray<string | null | undefined> | null | undefined
): string[] {
  const normalized = (values ?? [])
    .map(optionLabel)
    .filter((value): value is string => value !== null)
    .sort(
      (left, right) =>
        left.localeCompare(right, "en-US", { sensitivity: "base" }) ||
        (left < right ? -1 : left > right ? 1 : 0)
    )
  const unique = new Map<string, string>()

  for (const value of normalized) {
    const identity = value.toLocaleLowerCase("en-US")
    if (!unique.has(identity)) unique.set(identity, value)
  }

  const result = [...unique.values()]
  if (result.length > MAX_MULTI_SELECT_OPTIONS) {
    throw new Error(
      `Todoist ${property} produced ${result.length} values; Notion supports at most ${MAX_MULTI_SELECT_OPTIONS}.`
    )
  }
  return result
}

function validTimeZone(value: string): string {
  const timeZone = value.trim()
  if (!timeZone) throw new Error("Todoist user timezone is empty.")
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format()
  } catch {
    throw new Error("Todoist user timezone is invalid.")
  }
  return timeZone
}

type LocalParts = {
  date: string
  dateTime: string
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  )
}

function localParts(value: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: validTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value
  const year = part("year")
  const month = part("month")
  const day = part("day")
  const hour = part("hour")
  const minute = part("minute")
  const second = part("second")
  if (!year || !month || !day || !hour || !minute || !second) {
    throw new Error("Todoist local date could not be formatted.")
  }
  const date = `${year}-${month}-${day}`
  return { date, dateTime: `${date}T${hour}:${minute}:${second}` }
}

function addCalendarDays(date: string, days: number): string {
  if (!validCalendarDate(date)) {
    throw new Error("Todoist local date is invalid.")
  }
  const milliseconds = Date.parse(`${date}T00:00:00Z`)
  return new Date(milliseconds + days * 86_400_000).toISOString().slice(0, 10)
}

function normalizedLocalDateTime(value: string): string | null {
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d+)?)?$/u
  )
  if (!match) return null
  const normalized = `${match[1]}T${match[2]}:${match[3]}:${match[4] ?? "00"}`
  return validCalendarDate(match[1]!) &&
    Number.isFinite(Date.parse(`${normalized}Z`))
    ? normalized
    : null
}

function absoluteDateTime(value: string): Date | null {
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/iu
  )
  if (!match || !validCalendarDate(match[1]!)) return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

/** Classify a Todoist due value against one pinned user-local observation. */
export function classifyDue(
  due: DueValue | null | undefined,
  userTimeZone: string,
  observedAt: Date | string = new Date()
): DueClassification {
  const raw = due?.date?.trim()
  if (!raw) {
    return { status: "No due date", dueNextSevenDays: false }
  }
  if (!validCalendarDate(raw.slice(0, 10))) {
    throw new Error(
      /^\d{4}-\d{2}-\d{2}$/u.test(raw)
        ? "Todoist task due date is invalid."
        : "Todoist task due timestamp is invalid."
    )
  }

  const observed =
    observedAt instanceof Date ? observedAt : new Date(observedAt)
  if (!Number.isFinite(observed.getTime())) {
    throw new Error("Todoist due-status observation time is invalid.")
  }
  const localNow = localParts(observed, userTimeZone)
  const sevenDaysFromToday = addCalendarDays(localNow.date, 7)

  let dueDate: string
  let sortKey: string
  let overdue: boolean

  if (/^\d{4}-\d{2}-\d{2}$/u.test(raw)) {
    if (!validCalendarDate(raw)) {
      throw new Error("Todoist task due date is invalid.")
    }
    dueDate = raw
    sortKey = `${raw}T23:59:59`
    overdue = dueDate < localNow.date
  } else if (/(?:Z|[+-]\d{2}:\d{2})$/iu.test(raw)) {
    const dueInstant = absoluteDateTime(raw)
    if (!dueInstant) {
      throw new Error("Todoist task due timestamp is invalid.")
    }
    const localDue = localParts(dueInstant, userTimeZone)
    dueDate = localDue.date
    sortKey = localDue.dateTime
    overdue = dueInstant.getTime() < observed.getTime()
  } else {
    const localDue = normalizedLocalDateTime(raw)
    if (!localDue) {
      throw new Error("Todoist task due timestamp is invalid.")
    }
    dueDate = localDue.slice(0, 10)
    sortKey = localDue
    overdue = localDue < localNow.dateTime
  }

  if (overdue) return { status: "Overdue", sortKey, dueNextSevenDays: false }
  if (dueDate === localNow.date) {
    return { status: "Today", sortKey, dueNextSevenDays: true }
  }
  if (dueDate <= sevenDaysFromToday) {
    return { status: "Next 7 days", sortKey, dueNextSevenDays: true }
  }
  return { status: "Later", sortKey, dueNextSevenDays: false }
}

export function dateProperty(
  value: string | null | undefined,
  field: string,
  timeZone?: string | null
) {
  const date = value?.trim()
  if (!date) return []

  if (/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    if (!validCalendarDate(date)) {
      throw new Error(`Todoist ${field} is not a valid date.`)
    }
    return Builder.date(date)
  }

  const isAbsolute = /(?:Z|[+-]\d{2}:\d{2})$/iu.test(date)
  const absolute = isAbsolute ? absoluteDateTime(date) : null
  const local = isAbsolute ? null : normalizedLocalDateTime(date)
  if ((!isAbsolute && !local) || (isAbsolute && !absolute)) {
    throw new Error(`Todoist ${field} is not a valid ISO 8601 timestamp.`)
  }

  if (isAbsolute) {
    const milliseconds = absolute!.getTime()
    const zone = timeZone?.trim()
    if (zone) {
      const local = localParts(new Date(milliseconds), zone)
      return Builder.dateTime(local.dateTime, zone)
    }
    return Builder.dateTime(new Date(milliseconds).toISOString(), "UTC")
  }

  const zone = timeZone?.trim()
  return Builder.dateTime(local!, zone || undefined)
}

export function durationMinutes(
  duration: { amount: number; unit: string } | null | undefined
): number | null {
  if (!duration || !Number.isFinite(duration.amount) || duration.amount < 0) {
    return null
  }

  switch (duration.unit.trim().toLowerCase()) {
    case "minute":
    case "minutes":
      return duration.amount
    case "hour":
    case "hours":
      return duration.amount * 60
    case "day":
    case "days":
      return duration.amount * 24 * 60
    default:
      return null
  }
}

export function todoistTaskUrl(taskId: string): string {
  return `https://app.todoist.com/app/task/${encodeURIComponent(taskId)}`
}

export function todoistProjectUrl(projectId: string): string {
  return `https://app.todoist.com/app/project/${encodeURIComponent(projectId)}`
}
