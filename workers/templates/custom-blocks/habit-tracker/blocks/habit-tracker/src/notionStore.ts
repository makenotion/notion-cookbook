import type { NotionDateInput } from "@notionhq/custom-blocks"
import { useCallback, useMemo, useRef, useState } from "react"
import { NotionPage, createPage } from "@notionhq/custom-blocks/pages"
import type { NotionPageData } from "@notionhq/custom-blocks/pages"
import type {
  CellKey,
  Habit,
  HabitColor,
  HabitStore,
  StoreStatus,
} from "./types"
import { cellKey, HABIT_COLORS, isHabitColor } from "./types"
import { todayYmd } from "./dates"
import { useLoadedDataSource } from "./useLoadedDataSource"
import type { LoadedPageReference } from "./useLoadedDataSource"

const HABITS_KEY = "habits"
const LOG_KEY = "log"
const ROW_LIMIT = 999
const DATA_SOURCE_OPTIONS = { limit: ROW_LIMIT }

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

function richTextContent(row: NotionPageData, key: string): string {
  const property = row.getPropertyByKey(key)
  if (property?.type !== "rich_text") return ""
  return property.rich_text
    .map((segment) => {
      const text = segment["plain_text"]
      return typeof text === "string" ? text : ""
    })
    .join("")
}

function parseHabit(row: NotionPageData): Habit {
  const title = row.getPropertyByKey("name")
  const name =
    title?.type === "title"
      ? title.title
          .map((segment) => segment["plain_text"])
          .filter((part): part is string => typeof part === "string")
          .join("")
          .trim()
      : ""
  const icon = richTextContent(row, "icon").trim()
  const colorProperty = row.getPropertyByKey("color")
  const colorValue =
    colorProperty?.type === "select" ? colorProperty.select?.name : undefined
  // Unknown or missing color -> neutral gray, never a broken slot.
  const color = isHabitColor(colorValue) ? colorValue : "gray"
  return { id: row.pageKey, name: name || "Untitled", icon, color }
}

type LogRow = { reference: NotionPage; key: CellKey }

function parseLog(row: LoadedPageReference): LogRow | null {
  const dateProperty = row.data.getPropertyByKey("date")
  const date = parseDate(
    dateProperty?.type === "date" ? dateProperty.date : null
  )
  const habitId = parseRelation(row.data)
  if (!date || !habitId) return null
  return { reference: row.reference, key: cellKey(habitId, date) }
}

export function useNotionStore(): HabitStore {
  const habitsDS = useLoadedDataSource(HABITS_KEY, DATA_SOURCE_OPTIONS)
  const logDS = useLoadedDataSource(LOG_KEY, DATA_SOURCE_OPTIONS)
  const habitsItems = habitsDS.status === "success" ? habitsDS.value.items : []
  const logItems = logDS.status === "success" ? logDS.value.items : []

  // Optimistic overlay on top of host-delivered rows.
  // addedByKey: cellKey -> created page id ("" while the create is in flight).
  const [addedByKey, setAddedByKey] = useState<Map<CellKey, NotionPage | "">>(
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
    const byKey = new Map<CellKey, NotionPage[]>()
    for (const row of logItems) {
      const log = parseLog(row)
      if (!log) continue
      const ids = byKey.get(log.key)
      if (ids) ids.push(log.reference)
      else byKey.set(log.key, [log.reference])
    }
    return byKey
  }, [logItems])

  // When the log query is truncated, remember where the loaded window starts
  // so streaks can cap gracefully instead of under-counting silently.
  const logWindowStart = useMemo(() => {
    if (logDS.status !== "success" || !logDS.value.hasMore) return undefined
    let min: string | undefined
    for (const row of logItems) {
      const log = parseLog(row)
      if (!log) continue
      const date = log.key.slice(log.key.indexOf("|") + 1)
      if (min === undefined || date < min) min = date
    }
    return min ?? todayYmd()
  }, [
    logDS.status,
    logDS.status === "success" ? logDS.value.hasMore : false,
    logItems,
  ])

  const habits = useMemo(() => {
    const fromServer = habitsItems.map(({ data }) => parseHabit(data))
    const seen = new Set(fromServer.map((h) => h.id))
    const extras = localHabits.filter((h) => !seen.has(h.id))
    return [...fromServer, ...extras]
  }, [habitsItems, localHabits])

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
          setAddedByKey((prev) => new Map(prev).set(key, result.page))
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
      const localPage = addedByKey.get(key)
      if (localPage === "") {
        // The create is still in flight; ignore this tap rather than race it.
        return false
      }
      const pages = new Map<string, NotionPage>()
      for (const page of serverLogs.get(key) ?? [])
        pages.set(page.getKey(), page)
      if (localPage !== undefined) {
        pages.set(localPage.getKey(), localPage)
      }
      if (pages.size === 0) return false
      setRemovedKeys((prev) => new Set(prev).add(key))
      const results = await Promise.all(
        [...pages.values()].map((page) => page.archive())
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
        const pageKey = result.page.getKey()
        setLocalHabits((prev) =>
          prev.map((h) =>
            h.id === tempId ? { id: pageKey, name, icon, color } : h
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
    habitsDS.status === "success" &&
    logDS.status === "success" &&
    (!habitsDS.value.propertyIdsByKey.name ||
      !habitsDS.value.propertyIdsByKey.icon ||
      !habitsDS.value.propertyIdsByKey.color ||
      !logDS.value.propertyIdsByKey.name ||
      !logDS.value.propertyIdsByKey.date ||
      !logDS.value.propertyIdsByKey.habit)
  const dataSourceError =
    habitsDS.status === "error"
      ? habitsDS.error
      : logDS.status === "error"
        ? logDS.error
        : undefined
  if (
    habitsDS.status === "loading" ||
    logDS.status === "loading" ||
    (habitsDS.status === "success" &&
      habitsDS.value.isLoading &&
      habitsItems.length === 0) ||
    (logDS.status === "success" &&
      logDS.value.isLoading &&
      logItems.length === 0)
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
