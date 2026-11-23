// ───────────────────────────────────────────────────────────────────
// Strict date parsing shared by adapters and persisted-state validation
// ───────────────────────────────────────────────────────────────────

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/
// A few office systems return a date followed directly by its UTC offset
// ("2007-09-25-04:00") instead of a conventional timestamp.
const OFFICE_DAY_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})([+-])(\d{2}):(\d{2})$/
// ISO timestamp at minute or second precision. A timezone is mandatory:
// accepting a bare or malformed suffix would let strings such as
// "2024-01-01Trash" masquerade as validated source dates.
const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/
const UTC_ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    return leap ? 29 : 28
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function validCalendarDay(match: RegExpExecArray): boolean {
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  return (
    year >= 1 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  )
}

// ISO 8601 offsets range through 14:00; when the hour is 14 the minute must
// be zero. This also rejects superficially-shaped values such as +24:99.
function validOffset(value: string): boolean {
  if (value === "Z") return true
  const match = /^[+-](\d{2}):(\d{2})$/.exec(value)
  if (!match) return false
  const hour = Number(match[1])
  const minute = Number(match[2])
  return hour <= 14 && minute <= 59 && (hour < 14 || minute === 0)
}

// Returns a canonical YYYY-MM-DD for an exact date or an ISO timestamp
// beginning with that date. Impossible calendar dates return null instead of
// relying on Date's rollover semantics (for example, February 30 -> March 2).
export function parseIsoDay(value: unknown): string | null {
  if (typeof value !== "string") return null
  const text = value.trim()

  const exactDay = ISO_DAY.exec(text)
  if (exactDay) {
    return validCalendarDay(exactDay)
      ? `${exactDay[1]}-${exactDay[2]}-${exactDay[3]}`
      : null
  }

  const officeDay = OFFICE_DAY_WITH_OFFSET.exec(text)
  if (officeDay) {
    const offset = `${officeDay[4]}${officeDay[5]}:${officeDay[6]}`
    return validCalendarDay(officeDay) && validOffset(offset)
      ? `${officeDay[1]}-${officeDay[2]}-${officeDay[3]}`
      : null
  }

  const timestamp = ISO_TIMESTAMP.exec(text)
  if (!timestamp || !validCalendarDay(timestamp)) return null
  const hour = Number(timestamp[4])
  const minute = Number(timestamp[5])
  const second = timestamp[6] === undefined ? 0 : Number(timestamp[6])
  if (hour > 23 || minute > 59 || second > 59 || !validOffset(timestamp[8])) {
    return null
  }
  return `${timestamp[1]}-${timestamp[2]}-${timestamp[3]}`
}

// Missing values are represented by null. A present but malformed value is a
// source-format failure and must be thrown while still inside SourceRunner so
// last-known-good data can serve instead of persisting a destructive blank.
export function strictIsoDay(value: unknown, context: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === "string" && value.trim() === "") return null
  const parsed = parseIsoDay(value)
  if (!parsed)
    throw new Error(`${context}: invalid date ${JSON.stringify(value)}`)
  return parsed
}

// Accept UTC timestamps with optional 1-3 digit milliseconds and return the
// canonical form produced by Date#toISOString. The round trip rejects both
// impossible dates and Date.parse's permissive, implementation-defined forms.
export function canonicalUtcTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null
  const match = UTC_ISO_TIMESTAMP.exec(value)
  if (!match) return null
  const [, year, month, day, hour, minute, second, rawMillis] = match
  const candidate = `${year}-${month}-${day}T${hour}:${minute}:${second}.${(
    rawMillis ?? ""
  ).padEnd(3, "0")}Z`
  const epoch = Date.parse(candidate)
  if (!Number.isFinite(epoch)) return null
  const canonical = new Date(epoch).toISOString()
  return canonical === candidate ? canonical : null
}
