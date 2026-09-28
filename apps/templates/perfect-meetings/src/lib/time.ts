/** Offset of `timeZone` from UTC at the given instant, in milliseconds. */
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

export function localDate(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant))
}

/** The local calendar day containing `instant`, as a date string and UTC bounds. */
export function localDay(
  instant: number,
  timeZone: string
): { date: string; startMs: number; endMs: number } {
  const date = localDate(instant, timeZone)
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ]
  const midnight = (d: number) => {
    const guess = Date.UTC(year, month - 1, d)
    return guess - zoneOffsetMs(guess - zoneOffsetMs(guess, timeZone), timeZone)
  }
  return { date, startMs: midnight(day), endMs: midnight(day + 1) }
}

/** Whether a Notion date value (all-day date or date-time) starts on the given local day. */
export function startsOnDay(
  start: string,
  day: { date: string; startMs: number; endMs: number }
): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) return start === day.date
  const ms = Date.parse(start)
  return ms >= day.startMs && ms < day.endMs
}
