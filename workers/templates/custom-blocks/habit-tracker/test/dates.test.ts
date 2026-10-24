import assert from "node:assert/strict"
import test from "node:test"
import {
  addDays,
  addMonths,
  currentStreak,
  daysInMonth,
} from "../blocks/habit-tracker/src/dates"

test("date helpers cross month and year boundaries", () => {
  assert.equal(daysInMonth(2024, 1), 29)
  assert.equal(addDays("2026-01-01", -1), "2025-12-31")
  assert.deepEqual(addMonths({ year: 2026, month: 0 }, -1), {
    year: 2025,
    month: 11,
  })
})

test("current streak ends today or yesterday and reports a truncated window", () => {
  const completed = new Set(["2026-07-20", "2026-07-21", "2026-07-22"])
  const isDone = (date: string) => completed.has(date)

  assert.deepEqual(currentStreak(isDone, "2026-07-23"), {
    count: 3,
    capped: false,
  })
  assert.deepEqual(currentStreak(isDone, "2026-07-23", "2026-07-20"), {
    count: 3,
    capped: true,
  })
})
