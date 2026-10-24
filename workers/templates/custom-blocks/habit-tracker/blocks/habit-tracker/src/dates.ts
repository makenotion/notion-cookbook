/** Local-timezone date helpers. All dates are "YYYY-MM-DD" strings. */

export type YMD = string

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** month is 0-based. */
export function ymdOf(year: number, month: number, day: number): YMD {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`
}

export function ymd(d: Date): YMD {
  return ymdOf(d.getFullYear(), d.getMonth(), d.getDate())
}

export function todayYmd(): YMD {
  return ymd(new Date())
}

/** month is 0-based. */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

export function addDays(date: YMD, delta: number): YMD {
  const [y, m, d] = date.split("-").map(Number)
  const dt = new Date(y, m - 1, d + delta)
  return ymd(dt)
}

/** 0 = Sunday … 6 = Saturday. month is 0-based. */
export function weekday(year: number, month: number, day: number): number {
  return new Date(year, month, day).getDay()
}

export function isWeekend(year: number, month: number, day: number): boolean {
  const w = weekday(year, month, day)
  return w === 0 || w === 6
}

export type MonthRef = { year: number; month: number }

export function monthOf(date: YMD): MonthRef {
  const [y, m] = date.split("-").map(Number)
  return { year: y, month: m - 1 }
}

export function addMonths(ref: MonthRef, delta: number): MonthRef {
  const dt = new Date(ref.year, ref.month + delta, 1)
  return { year: dt.getFullYear(), month: dt.getMonth() }
}

export function sameMonth(a: MonthRef, b: MonthRef): boolean {
  return a.year === b.year && a.month === b.month
}

/** -1 if ref's month is before date's month, 0 same, 1 after. */
export function compareMonthToDate(ref: MonthRef, date: YMD): number {
  const m = monthOf(date)
  if (ref.year !== m.year) return ref.year < m.year ? -1 : 1
  if (ref.month !== m.month) return ref.month < m.month ? -1 : 1
  return 0
}

export type Streak = { count: number; capped: boolean }

/**
 * Current streak: consecutive completed days ending today, or ending yesterday
 * when today hasn't been checked yet. Counting walks backwards across month
 * boundaries. When `floor` is given (the earliest loaded log date), counting
 * stops there and the streak is flagged `capped` instead of guessing beyond
 * the loaded window.
 */
export function currentStreak(
  isDone: (date: YMD) => boolean,
  today: YMD,
  floor?: YMD
): Streak {
  let anchor = today
  if (!isDone(anchor)) anchor = addDays(today, -1)
  let count = 0
  let d = anchor
  while (isDone(d)) {
    count++
    if (floor !== undefined && d <= floor) {
      return { count, capped: true }
    }
    d = addDays(d, -1)
    if (count > 3660) return { count, capped: true } // safety valve
  }
  return { count, capped: false }
}
