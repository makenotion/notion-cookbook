import { useCallback, useMemo, useRef, useState } from "react"
import type { NotionDateInput } from "@notionhq/custom-blocks"
import {
  NotionDataSource,
  type DataSourceQueryItem,
} from "@notionhq/custom-blocks/data-sources"
import {
  createPage,
  NotionPage,
  type NotionPageData,
} from "@notionhq/custom-blocks/pages"
import { useQuerySubscription } from "@notionhq/custom-blocks/react"
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
const QUERY_OPTIONS = { limit: ROW_LIMIT }
const HABITS_QUERY = NotionDataSource.fromKey(HABITS_KEY).createQuery()
const LOG_QUERY = NotionDataSource.fromKey(LOG_KEY).createQuery()
const EMPTY_ROWS: readonly DataSourceQueryItem[] = []

/**
 * Date-only values use `YYYY-MM-DD`; datetime values use ISO 8601. Keeping the
 * first ten characters gives both forms the calendar day without timezone shifts.
 */
function parseDate(value: NotionDateInput | null): string | null {
  return value?.start.slice(0, 10) ?? null
}

function parseRelation(row: NotionPageData): string | null {
  const property = row.getPropertyByKey("habit")
  return property?.type === "relation"
    ? (property.relation[0]?.id ?? null)
    : null
}

function readTextSegment(segment: Record<string, unknown>): string {
  const plainText = segment["plain_text"]
  if (typeof plainText === "string") return plainText
  const text = segment["text"]
  return typeof text === "object" &&
    text !== null &&
    "content" in text &&
    typeof text.content === "string"
    ? text.content
    : ""
}

function parseHabit(row: NotionPageData): Habit {
  const title = row.getPropertyByKey("name")
  const name =
    title?.type === "title"
      ? title.title.map(readTextSegment).join("").trim()
      : ""
  const iconProperty = row.getPropertyByKey("icon")
  const icon =
    iconProperty?.type === "rich_text"
      ? iconProperty.rich_text.map(readTextSegment).join("").trim()
      : ""
  const colorProperty = row.getPropertyByKey("color")
  const colorValue =
    colorProperty?.type === "select" ? colorProperty.select?.name : undefined
  // Unknown or missing color -> neutral gray, never a broken slot.
  const color = isHabitColor(colorValue) ? colorValue : "gray"
  return { id: row.pageKey, name: name || "Untitled", icon, color }
}

type LogRow = { id: string; key: CellKey }

function parseLog(row: NotionPageData): LogRow | null {
  const dateProperty = row.getPropertyByKey("date")
  const date = parseDate(
    dateProperty?.type === "date" ? dateProperty.date : null
  )
  const habitId = parseRelation(row)
  if (!date || !habitId) return null
  return { id: row.pageKey, key: cellKey(habitId, date) }
}

export function useNotionStore(): HabitStore {
  const habitsResult = useQuerySubscription(HABITS_QUERY, QUERY_OPTIONS)
  const logResult = useQuerySubscription(LOG_QUERY, QUERY_OPTIONS)
  const habitsSnapshot =
    habitsResult.status === "success" ? habitsResult.value : undefined
  const logSnapshot =
    logResult.status === "success" ? logResult.value : undefined
  const habitRows = habitsSnapshot?.items ?? EMPTY_ROWS
  const logRows = logSnapshot?.items ?? EMPTY_ROWS
  const hasMoreLogs = logSnapshot?.hasMore ?? false

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
    for (const { data } of logRows) {
      const log = parseLog(data)
      if (!log) continue
      const ids = byKey.get(log.key)
      if (ids) ids.push(log.id)
      else byKey.set(log.key, [log.id])
    }
    return byKey
  }, [logRows])

  // When the log query is truncated, remember where the loaded window starts
  // so streaks can cap gracefully instead of under-counting silently.
  const logWindowStart = useMemo(() => {
    if (!hasMoreLogs) return undefined
    let min: string | undefined
    for (const { data } of logRows) {
      const log = parseLog(data)
      if (!log) continue
      const date = log.key.slice(log.key.indexOf("|") + 1)
      if (min === undefined || date < min) min = date
    }
    return min ?? todayYmd()
  }, [hasMoreLogs, logRows])

  const habits = useMemo(() => {
    const fromServer = habitRows.map(({ data }) => parseHabit(data))
    const seen = new Set(fromServer.map((h) => h.id))
    const extras = localHabits.filter((h) => !seen.has(h.id))
    return [...fromServer, ...extras]
  }, [habitRows, localHabits])

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
        const result = await createPage({
          parent: { type: "data_source_key", dataSourceKey: LOG_KEY },
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
          const pageId = result.page.getKey()
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
      if (localId !== undefined) ids.add(localId)
      if (ids.size === 0) return false
      setRemovedKeys((prev) => new Set(prev).add(key))
      const results = await Promise.all(
        [...ids].map((id) => NotionPage.fromKey(id).archive())
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
      const result = await createPage({
        parent: { type: "data_source_key", dataSourceKey: HABITS_KEY },
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
        const pageId = result.page.getKey()
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
  const missingBinding =
    !habitsSnapshot?.propertyIdsByKey.name ||
    !habitsSnapshot?.propertyIdsByKey.icon ||
    !habitsSnapshot?.propertyIdsByKey.color ||
    !logSnapshot?.propertyIdsByKey.name ||
    !logSnapshot?.propertyIdsByKey.date ||
    !logSnapshot?.propertyIdsByKey.habit
  const dataSourceError =
    habitsResult.status === "error"
      ? habitsResult.error
      : logResult.status === "error"
        ? logResult.error
        : undefined
  if (
    habitsResult.status === "loading" ||
    logResult.status === "loading" ||
    (habitsSnapshot?.isLoading && habitRows.length === 0) ||
    (logSnapshot?.isLoading && logRows.length === 0)
  ) {
    status = "loading"
  } else if (dataSourceError || missingBinding) {
    status = "unbound"
    unboundDetail =
      dataSourceError?.message ??
      "Map the habit and log data sources and their required properties in the block settings."
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
