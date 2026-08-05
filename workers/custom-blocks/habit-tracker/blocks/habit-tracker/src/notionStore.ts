import { useCallback, useMemo, useRef, useState } from "react"
import { pages } from "@notionhq/custom-blocks"
import type {
  NotionDataSourcePage,
  NotionDateValue,
  NotionPageId,
  NotionRecordPointer,
} from "@notionhq/custom-blocks"
import { useDataSource } from "@notionhq/custom-blocks/react"
import type {
  CellKey,
  Habit,
  HabitColor,
  HabitStore,
  StoreStatus,
} from "./types"
import { cellKey, HABIT_COLORS, isHabitColor } from "./types"
import { todayYmd } from "./dates"

const HABITS_KEY = "habits"
const LOG_KEY = "log"
const ROW_LIMIT = 999

/**
 * Extract the day key from a Notion date value. `start_date` is already a
 * plain "YYYY-MM-DD" calendar date (datetime variants carry the time in a
 * separate `start_time` field), so this never shifts across timezones the way
 * slicing a UTC ISO timestamp would.
 */
function parseDate(value: unknown): string | null {
  if (value == null || typeof value !== "object") return null
  const date = value as NotionDateValue
  if (typeof date.start_date === "string" && date.start_date.length >= 10) {
    return date.start_date.slice(0, 10)
  }
  return null
}

function parseRelation(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const first = value[0] as NotionRecordPointer
  return typeof first?.id === "string" ? first.id : null
}

function parseHabit(row: NotionDataSourcePage): Habit {
  const props = row.propertiesByKey
  const name = typeof props.name === "string" ? props.name.trim() : ""
  const icon = typeof props.icon === "string" ? props.icon.trim() : ""
  // Unknown or missing color -> neutral gray, never a broken slot.
  const color = isHabitColor(props.color) ? props.color : "gray"
  return { id: row.id, name: name || "Untitled", icon, color }
}

type LogRow = { id: string; key: CellKey }

function parseLog(row: NotionDataSourcePage): LogRow | null {
  const date = parseDate(row.propertiesByKey.date)
  const habitId = parseRelation(row.propertiesByKey.habit)
  if (!date || !habitId) return null
  return { id: row.id, key: cellKey(habitId, date) }
}

export function useNotionStore(): HabitStore {
  const habitsDS = useDataSource(HABITS_KEY, { limit: ROW_LIMIT })
  const logDS = useDataSource(LOG_KEY, { limit: ROW_LIMIT })

  // Optimistic overlay on top of host-delivered rows.
  // addedByKey: cellKey -> created page id ("" while the create is in flight).
  const [addedByKey, setAddedByKey] = useState<Map<CellKey, string>>(
    () => new Map()
  )
  const [removedKeys, setRemovedKeys] = useState<Set<CellKey>>(() => new Set())
  // Habits created from the block that the host may not have re-delivered yet.
  const [localHabits, setLocalHabits] = useState<Habit[]>([])
  const [lastError, setLastError] = useState<string | null>(null)
  const localHabitCount = useRef(0)

  // Duplicate rows for the same habit+day collapse to one completed cell;
  // all row ids are kept so toggling off deletes every duplicate.
  const serverLogs = useMemo(() => {
    const byKey = new Map<CellKey, string[]>()
    for (const row of logDS.items) {
      const log = parseLog(row)
      if (!log) continue
      const ids = byKey.get(log.key)
      if (ids) ids.push(log.id)
      else byKey.set(log.key, [log.id])
    }
    return byKey
  }, [logDS.items])

  // When the log query is truncated, remember where the loaded window starts
  // so streaks can cap gracefully instead of under-counting silently.
  const logWindowStart = useMemo(() => {
    if (!logDS.hasMore) return undefined
    let min: string | undefined
    for (const row of logDS.items) {
      const log = parseLog(row)
      if (!log) continue
      const date = log.key.slice(log.key.indexOf("|") + 1)
      if (min === undefined || date < min) min = date
    }
    return min ?? todayYmd()
  }, [logDS.hasMore, logDS.items])

  const habits = useMemo(() => {
    const fromServer = habitsDS.items.map(parseHabit)
    const seen = new Set(fromServer.map((h) => h.id))
    const extras = localHabits.filter((h) => !seen.has(h.id))
    return [...fromServer, ...extras]
  }, [habitsDS.items, localHabits])

  const completed = useMemo(() => {
    const set = new Set<CellKey>(serverLogs.keys())
    for (const key of addedByKey.keys()) set.add(key)
    for (const key of removedKeys) set.delete(key)
    return set
  }, [serverLogs, addedByKey, removedKeys])

  const habitsById = useMemo(() => {
    const map = new Map<string, Habit>()
    for (const h of habits) map.set(h.id, h)
    return map
  }, [habits])

  const toggle = useCallback(
    async (habitId: string, date: string, next: boolean): Promise<boolean> => {
      const key = cellKey(habitId, date)
      if (next) {
        // Optimistically mark done.
        setAddedByKey((prev) => new Map(prev).set(key, ""))
        setRemovedKeys((prev) => {
          if (!prev.has(key)) return prev
          const copy = new Set(prev)
          copy.delete(key)
          return copy
        })
        const habitName = habitsById.get(habitId)?.name ?? "Habit"
        const result = await pages.create({
          parent: { type: "data_source_key", key: LOG_KEY },
          properties: {
            name: {
              type: "title",
              title: [
                { type: "text", text: { content: `${habitName} — ${date}` } },
              ],
            },
            date: { type: "date", date: { start: date } },
            habit: { type: "relation", relation: [{ id: habitId }] },
          },
        })
        if (result.status === "success") {
          const pageId = result.page.id
          setAddedByKey((prev) => new Map(prev).set(key, pageId))
          return true
        }
        // Revert.
        setAddedByKey((prev) => {
          const copy = new Map(prev)
          copy.delete(key)
          return copy
        })
        setLastError("Couldn't save that check — it was undone.")
        return false
      }

      // Toggling off: archive every matching row (duplicates included).
      const localId = addedByKey.get(key)
      if (localId === "") {
        // The create is still in flight; ignore this tap rather than race it.
        return false
      }
      const ids = new Set<string>(serverLogs.get(key) ?? [])
      if (localId) ids.add(localId)
      if (ids.size === 0) return false
      setRemovedKeys((prev) => new Set(prev).add(key))
      const results = await Promise.all(
        [...ids].map((id) => pages.delete(id as NotionPageId))
      )
      if (results.every((r) => r.status === "success")) return true
      // Revert.
      setRemovedKeys((prev) => {
        const copy = new Set(prev)
        copy.delete(key)
        return copy
      })
      setLastError("Couldn't remove that check — it was restored.")
      return false
    },
    [addedByKey, serverLogs, habitsById]
  )

  const createHabit = useCallback(
    async (name: string): Promise<boolean> => {
      // Pick the least-used color for the new habit.
      const usage = new Map<HabitColor, number>(HABIT_COLORS.map((c) => [c, 0]))
      for (const h of habits) {
        if (isHabitColor(h.color))
          usage.set(h.color, (usage.get(h.color) ?? 0) + 1)
      }
      let color: HabitColor = HABIT_COLORS[0]
      let best = Number.POSITIVE_INFINITY
      for (const c of HABIT_COLORS) {
        const n = usage.get(c) ?? 0
        if (n < best) {
          best = n
          color = c
        }
      }
      const icon = "🌱"
      // Optimistic row (non-toggleable until the real page id arrives).
      localHabitCount.current += 1
      const tempId = `pending-${localHabitCount.current}`
      setLocalHabits((prev) => [
        ...prev,
        { id: tempId, name, icon, color, pending: true },
      ])
      const result = await pages.create({
        parent: { type: "data_source_key", key: HABITS_KEY },
        properties: {
          name: {
            type: "title",
            title: [{ type: "text", text: { content: name } }],
          },
          icon: {
            type: "rich_text",
            rich_text: [{ type: "text", text: { content: icon } }],
          },
          color: { type: "select", select: { name: color } },
        },
      })
      if (result.status === "success") {
        const pageId = result.page.id
        setLocalHabits((prev) =>
          prev.map((h) =>
            h.id === tempId ? { id: pageId, name, icon, color } : h
          )
        )
        return true
      }
      // Revert the optimistic row.
      setLocalHabits((prev) => prev.filter((h) => h.id !== tempId))
      setLastError("Couldn't create the habit — it was removed.")
      return false
    },
    [habits]
  )

  const clearError = useCallback(() => setLastError(null), [])

  let status: StoreStatus = "ready"
  let unboundDetail: string | undefined
  const dsError = habitsDS.error ?? logDS.error
  if (dsError) {
    status = "unbound"
    unboundDetail = dsError.message
  } else if (
    (habitsDS.isLoading && habitsDS.items.length === 0) ||
    (logDS.isLoading && logDS.items.length === 0)
  ) {
    status = "loading"
  }

  return useMemo(
    () => ({
      status,
      unboundDetail,
      habits,
      completed,
      logWindowStart,
      toggle,
      createHabit,
      lastError,
      clearError,
    }),
    [
      status,
      unboundDetail,
      habits,
      completed,
      logWindowStart,
      toggle,
      createHabit,
      lastError,
      clearError,
    ]
  )
}
