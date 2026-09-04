export const HABIT_COLORS = [
  "yellow",
  "blue",
  "pink",
  "green",
  "purple",
  "red",
  "orange",
  "teal",
] as const

export type HabitColor = (typeof HABIT_COLORS)[number]

export function isHabitColor(value: unknown): value is HabitColor {
  return (
    typeof value === "string" &&
    (HABIT_COLORS as readonly string[]).includes(value)
  )
}

/** The colors offered in the select; "gray" is the internal neutral fallback. */
export type HabitDisplayColor = HabitColor | "gray"

export type Habit = {
  id: string
  name: string
  /** An emoji typed by the user; may be empty. */
  icon: string
  color: HabitDisplayColor
  /** True while an optimistic create is still in flight. */
  pending?: boolean
}

/** `${habitId}|${YYYY-MM-DD}` */
export type CellKey = string

export function cellKey(habitId: string, date: string): CellKey {
  return `${habitId}|${date}`
}

export type StoreStatus = "loading" | "unbound" | "ready"

export type HabitStore = {
  status: StoreStatus
  /** Only meaningful when status === "unbound"; developer-facing detail. */
  unboundDetail?: string
  habits: Habit[]
  /** Set of cellKey(habitId, date) for every completed habit-day. */
  completed: ReadonlySet<CellKey>
  /**
   * Earliest date (YYYY-MM-DD) covered by the loaded log window, when the
   * window is known to be truncated. Streak counting stops here and renders
   * as "n+" instead of guessing.
   */
  logWindowStart?: string
  /** Toggle a habit-day. Optimistic; resolves false (and reverts) on failure. */
  toggle: (habitId: string, date: string, next: boolean) => Promise<boolean>
  /** Create a new habit. Resolves true on success. */
  createHabit: (name: string) => Promise<boolean>
  /** Last write error, for the quiet inline error line. */
  lastError: string | null
  clearError: () => void
}
