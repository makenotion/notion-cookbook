import { useCallback, useMemo, useRef, useState } from "react"
import { addDays, monthOf, todayYmd, ymdOf } from "./dates"
import type { CellKey, Habit, HabitStore } from "./types"
import { cellKey } from "./types"

/** Deterministic PRNG so mock screenshots are stable within a day. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const MOCK_HABITS: Habit[] = [
  { id: "mock-run", name: "Run", icon: "🏃", color: "green" },
  { id: "mock-read", name: "Read", icon: "📖", color: "blue" },
  { id: "mock-meditate", name: "Meditate", icon: "🧘", color: "purple" },
  { id: "mock-water", name: "Water", icon: "💧", color: "teal" },
  { id: "mock-journal", name: "Journal", icon: "✍️", color: "yellow" },
]

/** Extra rows for the many-habits stress state (?many=1): long names, missing
 * icon, unknown color -> gray fallback. */
export const MOCK_EXTRA_HABITS: Habit[] = [
  {
    id: "mock-walk",
    name: "Walk 10k steps and take the long way home through the park",
    icon: "🚶",
    color: "orange",
  },
  { id: "mock-stretch", name: "Stretch", icon: "", color: "pink" },
  { id: "mock-sugar", name: "No sugar", icon: "🚫", color: "gray" },
  { id: "mock-duolingo", name: "Duolingo", icon: "🦉", color: "green" },
  { id: "mock-piano", name: "Piano", icon: "🎹", color: "red" },
  { id: "mock-inbox", name: "Inbox zero", icon: "📥", color: "blue" },
  { id: "mock-floss", name: "Floss", icon: "🦷", color: "teal" },
  { id: "mock-sleep", name: "Sleep by 11", icon: "😴", color: "purple" },
  { id: "mock-pushups", name: "Pushups", icon: "💪", color: "orange" },
  { id: "mock-family", name: "Call family", icon: "📞", color: "yellow" },
  { id: "mock-sketch", name: "Sketch", icon: "", color: "gray" },
]

/**
 * ~70% realistic completion for the current month (plus a tail of the previous
 * month so streaks can cross the boundary), with:
 * - "Run" holding a 7+ day streak that ends today,
 * - "Meditate" at a 6-day streak ending yesterday (today unchecked — one tap = 7),
 * - one past perfect day, and today one tap away from perfect.
 */
export function buildMockCompleted(today: string): Set<CellKey> {
  const { year, month } = monthOf(today)
  const rng = mulberry32(year * 372 + month * 31 + 7)
  const done = new Set<CellKey>()

  const monthStart = ymdOf(year, month, 1)
  // Iterate from 10 days before the month start through today.
  let d = addDays(monthStart, -10)
  while (d <= today) {
    for (const habit of MOCK_HABITS) {
      if (rng() < 0.7) done.add(cellKey(habit.id, d))
    }
    d = addDays(d, 1)
  }

  // Force "Run" to an 8-day streak ending today.
  for (let i = 0; i < 8; i++) {
    done.add(cellKey("mock-run", addDays(today, -i)))
  }

  // Force "Meditate" to a 6-day streak ending yesterday, unchecked today.
  done.delete(cellKey("mock-meditate", today))
  for (let i = 1; i <= 6; i++) {
    done.add(cellKey("mock-meditate", addDays(today, -i)))
  }
  done.delete(cellKey("mock-meditate", addDays(today, -7)))

  // One past perfect day (3 days ago, if it's still in this month).
  const perfect = addDays(today, -3)
  if (perfect >= monthStart) {
    for (const habit of MOCK_HABITS) done.add(cellKey(habit.id, perfect))
  }

  // Today: everything done except Meditate + Journal, so a "perfect day"
  // can be earned live (and Meditate lands a 7-streak milestone).
  done.add(cellKey("mock-run", today))
  done.add(cellKey("mock-read", today))
  done.add(cellKey("mock-water", today))
  done.delete(cellKey("mock-journal", today))

  return done
}

const MOCK_LATENCY_MS = 120

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type MockOptions = {
  /** Start with no habits (empty teaching state). */
  empty?: boolean
  /** Every write fails, to exercise revert + inline error. */
  failWrites?: boolean
  /** Seed 16 habits to exercise vertical scrolling / long names. */
  many?: boolean
}

/** Add ~60% completion for the extra habits over the last 3 weeks. */
function extendMockCompleted(done: Set<CellKey>, today: string): Set<CellKey> {
  const rng = mulberry32(1234567)
  for (const habit of MOCK_EXTRA_HABITS) {
    for (let i = 0; i < 21; i++) {
      if (rng() < 0.6) done.add(cellKey(habit.id, addDays(today, -i)))
    }
  }
  return done
}

export function useMockStore(options: MockOptions = {}): HabitStore {
  const today = todayYmd()
  const [habits, setHabits] = useState<Habit[]>(() =>
    options.empty
      ? []
      : options.many
        ? [...MOCK_HABITS, ...MOCK_EXTRA_HABITS]
        : MOCK_HABITS
  )
  const [completed, setCompleted] = useState<Set<CellKey>>(() => {
    if (options.empty) return new Set()
    const done = buildMockCompleted(today)
    return options.many ? extendMockCompleted(done, today) : done
  })
  const [lastError, setLastError] = useState<string | null>(null)
  const idCounter = useRef(0)

  const toggle = useCallback(
    async (habitId: string, date: string, next: boolean): Promise<boolean> => {
      const key = cellKey(habitId, date)
      // Optimistic apply.
      setCompleted((prev) => {
        const copy = new Set(prev)
        if (next) copy.add(key)
        else copy.delete(key)
        return copy
      })
      await delay(MOCK_LATENCY_MS)
      if (options.failWrites) {
        // Revert.
        setCompleted((prev) => {
          const copy = new Set(prev)
          if (next) copy.delete(key)
          else copy.add(key)
          return copy
        })
        setLastError("Couldn't save that change — it was undone.")
        return false
      }
      return true
    },
    [options.failWrites]
  )

  const createHabit = useCallback(
    async (name: string): Promise<boolean> => {
      // Optimistic row, mirroring the real store.
      idCounter.current += 1
      const id = idCounter.current
      const tempId = `mock-pending-${id}`
      const colors: Habit["color"][] = ["pink", "orange", "red"]
      const color = colors[(id - 1) % colors.length]
      setHabits((prev) => [
        ...prev,
        { id: tempId, name, icon: "🌱", color, pending: true },
      ])
      await delay(MOCK_LATENCY_MS * 2)
      if (options.failWrites) {
        setHabits((prev) => prev.filter((h) => h.id !== tempId))
        setLastError("Couldn't create the habit — it was removed.")
        return false
      }
      setHabits((prev) =>
        prev.map((h) =>
          h.id === tempId
            ? { id: `mock-new-${id}`, name, icon: "🌱", color }
            : h
        )
      )
      return true
    },
    [options.failWrites]
  )

  const clearError = useCallback(() => setLastError(null), [])

  return useMemo(
    () => ({
      status: "ready" as const,
      habits,
      completed,
      toggle,
      createHabit,
      lastError,
      clearError,
    }),
    [habits, completed, toggle, createHabit, lastError, clearError]
  )
}

/** Static, read-only sample data for the unbound backdrop. */
export function useSampleStore(): HabitStore {
  const today = todayYmd()
  const completed = useMemo(() => buildMockCompleted(today), [today])
  const noopToggle = useCallback(async () => false, [])
  const noopCreate = useCallback(async () => false, [])
  const clearError = useCallback(() => undefined, [])
  return useMemo(
    () => ({
      status: "ready" as const,
      habits: MOCK_HABITS,
      completed,
      toggle: noopToggle,
      createHabit: noopCreate,
      lastError: null,
      clearError,
    }),
    [completed, noopToggle, noopCreate, clearError]
  )
}
