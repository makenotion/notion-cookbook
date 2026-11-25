import { useCallback, useEffect, useRef, useState } from "react"
import { NotionDataSource } from "@notionhq/custom-blocks/data-sources"
import {
  createPage,
  type NotionPage,
  type NotionPageData,
  type NotionPagePropertyValue,
  type NotionPagePropertyInputValue,
} from "@notionhq/custom-blocks/pages"
import { useQuerySubscription } from "@notionhq/custom-blocks/react"
import type { BoardItem, WhiteboardStore, SaveState } from "./model"
import {
  autoLabel,
  encodePoints,
  isItemColor,
  isItemType,
  parsePoints,
} from "./model"
import { validateWhiteboardBindings } from "./schema"

const DATA_SOURCE_KEY = "items"
const WRITE_DEBOUNCE_MS = 500
/** Notion rich text segments cap at 2000 chars; stay under it. */
const TEXT_CHUNK = 1900
const ITEMS_QUERY = NotionDataSource.fromKey(DATA_SOURCE_KEY).createQuery()

type ItemPatch = Partial<Omit<BoardItem, "id">>

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

function richTextContent(property: NotionPagePropertyValue | null): string {
  if (property?.type === "rich_text") {
    return property.rich_text.map(readTextSegment).join("")
  }
  if (property?.type === "title") {
    return property.title.map(readTextSegment).join("")
  }
  return ""
}

function numberValue(
  row: NotionPageData,
  key: string,
  fallback: number
): number {
  const property = row.getPropertyByKey(key)
  return property?.type === "number" &&
    typeof property.number === "number" &&
    Number.isFinite(property.number)
    ? property.number
    : fallback
}

function rowToItem(row: NotionPageData): BoardItem | null {
  const typeProperty = row.getPropertyByKey("type")
  const type =
    typeProperty?.type === "select" ? typeProperty.select?.name : undefined
  if (!isItemType(type)) return null
  const colorProperty = row.getPropertyByKey("color")
  const colorValue =
    colorProperty?.type === "select" ? colorProperty.select?.name : undefined
  return {
    id: row.pageKey,
    type,
    title: richTextContent(row.getPropertyByKey("title")),
    color: isItemColor(colorValue)
      ? colorValue
      : type === "sticky"
        ? "yellow"
        : "gray",
    x: numberValue(row, "x", 0),
    y: numberValue(row, "y", 0),
    width: numberValue(row, "width", type === "sticky" ? 160 : 0),
    height: numberValue(row, "height", type === "sticky" ? 160 : 0),
    points: parsePoints(richTextContent(row.getPropertyByKey("points"))),
    strokeWidth: numberValue(row, "strokeWidth", 2),
    z: numberValue(row, "z", 0),
  }
}

function chunkedText(content: string): Array<Record<string, unknown>> {
  if (content.length === 0) return []
  const out: Array<Record<string, unknown>> = []
  for (let i = 0; i < content.length; i += TEXT_CHUNK) {
    out.push({
      type: "text",
      text: { content: content.slice(i, i + TEXT_CHUNK) },
    })
  }
  return out
}

/** Build write values keyed by semantic key from a partial item. */
function patchToProperties(
  patch: ItemPatch
): Record<string, NotionPagePropertyInputValue> {
  const props: Record<string, NotionPagePropertyInputValue> = {}
  if (patch.title !== undefined) {
    props.title = { type: "title", title: chunkedText(patch.title) }
  }
  if (patch.type !== undefined) {
    props.type = { type: "select", select: { name: patch.type } }
  }
  if (patch.color !== undefined) {
    props.color = { type: "select", select: { name: patch.color } }
  }
  for (const key of [
    "x",
    "y",
    "width",
    "height",
    "strokeWidth",
    "z",
  ] as const) {
    const value = patch[key]
    if (value !== undefined) {
      props[key] = { type: "number", number: Math.round(value) }
    }
  }
  if (patch.points !== undefined) {
    props.points = {
      type: "rich_text",
      rich_text: chunkedText(encodePoints(patch.points)),
    }
  }
  return props
}

/**
 * Notion-backed whiteboard store: reconciles live rows with optimistic local
 * state, debounces writes (~500ms), creates/deletes pages eagerly.
 * Failed writes revert quietly; a small inline wisp shows save status.
 */
export function useNotionStore(): WhiteboardStore {
  const result = useQuerySubscription(ITEMS_QUERY, { limit: 999 })
  const snapshot = result.status === "success" ? result.value : undefined
  const rows = snapshot?.items
  const isLoading = snapshot?.isLoading ?? result.status === "loading"
  const hasLoadError = result.status === "error"

  const [local, setLocal] = useState<BoardItem[] | null>(null)
  const [saveState, setSaveState] = useState<SaveState>("idle")

  // localId -> real Notion page id ("" while a create is in flight).
  const pageIds = useRef(new Map<string, string>())
  // localId -> last state known to be persisted (for quiet reverts).
  const baselines = useRef(new Map<string, BoardItem>())
  // localId -> merged patch awaiting flush.
  const pending = useRef(new Map<string, ItemPatch>())
  // localId -> patches currently being written. Keep these overlaid when a
  // live data-source snapshot arrives before the corresponding write result.
  const activePatches = useRef(new Map<string, ItemPatch[]>())
  // Locally-created items stay visible until they appear in a live snapshot.
  const optimisticCreates = useRef(new Set<string>())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const inFlight = useRef(0)
  const errorUntil = useRef(0)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pageCache = useRef(new Map<string, NotionPage>())
  for (const { page, data } of rows ?? []) {
    pageCache.current.set(data.pageKey, page)
  }
  const localSeq = useRef(0)

  // Reconcile each settled snapshot while preserving local creates and unconfirmed writes.
  useEffect(() => {
    if (isLoading || rows === undefined) return

    const localIdByPageId = new Map<string, string>()
    for (const [localId, pageId] of pageIds.current) {
      if (pageId) localIdByPageId.set(pageId, localId)
    }

    const synced: BoardItem[] = []
    const syncedIds = new Set<string>()
    for (const { data } of rows) {
      const remoteItem = rowToItem(data)
      if (!remoteItem) continue

      const localId = localIdByPageId.get(remoteItem.id) ?? remoteItem.id
      const item = { ...remoteItem, id: localId }
      baselines.current.set(localId, item)
      pageIds.current.set(localId, remoteItem.id)
      optimisticCreates.current.delete(localId)

      for (const patch of activePatches.current.get(localId) ?? []) {
        Object.assign(item, patch)
      }
      Object.assign(item, pending.current.get(localId))
      synced.push(item)
      syncedIds.add(localId)
    }

    setLocal((previous) => {
      const localOnly = (previous ?? []).filter(
        (item) =>
          optimisticCreates.current.has(item.id) && !syncedIds.has(item.id)
      )
      return [...synced, ...localOnly].sort((a, b) => a.z - b.z)
    })
  }, [isLoading, rows])

  useEffect(() => {
    const timerMap = timers.current
    const idle = idleTimer
    return () => {
      for (const t of timerMap.values()) clearTimeout(t)
      clearTimeout(idle.current)
    }
  }, [])

  const beginWrite = useCallback(() => {
    inFlight.current += 1
    if (Date.now() >= errorUntil.current) {
      clearTimeout(idleTimer.current)
      setSaveState("saving")
    }
  }, [])

  const endWrite = useCallback((ok: boolean) => {
    inFlight.current = Math.max(0, inFlight.current - 1)
    if (!ok) {
      errorUntil.current = Date.now() + 2500
      clearTimeout(idleTimer.current)
      setSaveState("error")
      idleTimer.current = setTimeout(() => setSaveState("idle"), 2500)
      return
    }
    if (inFlight.current === 0 && Date.now() >= errorUntil.current) {
      clearTimeout(idleTimer.current)
      setSaveState("saved")
      idleTimer.current = setTimeout(() => setSaveState("idle"), 1400)
    }
  }, [])

  /** Quietly restore the patched fields from the last persisted state. */
  const revertPatch = useCallback((localId: string, patch: ItemPatch) => {
    const base = baselines.current.get(localId)
    if (!base) return
    const keys = Object.keys(patch) as Array<keyof ItemPatch>
    const overlays = [
      ...(activePatches.current.get(localId) ?? []),
      pending.current.get(localId),
    ].filter((value): value is ItemPatch => value !== undefined)
    setLocal((prev) =>
      prev
        ? prev.map((it) => {
            if (it.id !== localId) return it
            const restored: BoardItem = { ...it }
            for (const key of keys) {
              ;(restored as Record<string, unknown>)[key] = base[key]
              for (const overlay of overlays) {
                if (overlay[key] !== undefined) {
                  ;(restored as Record<string, unknown>)[key] = overlay[key]
                }
              }
            }
            return restored
          })
        : prev
    )
  }, [])

  const flush = useCallback(
    (localId: string) => {
      timers.current.delete(localId)
      const pageId = pageIds.current.get(localId)
      if (pageId === undefined) return // deleted before flush
      if (pageId === "") {
        // Create still in flight — retry shortly.
        const t = setTimeout(() => flush(localId), WRITE_DEBOUNCE_MS)
        timers.current.set(localId, t)
        return
      }
      const patch = pending.current.get(localId)
      if (!patch) return
      pending.current.delete(localId)

      const page = pageCache.current.get(pageId)
      if (!page) return
      const properties = patchToProperties(patch)

      const active = activePatches.current.get(localId) ?? []
      activePatches.current.set(localId, [...active, patch])
      const clearActivePatch = () => {
        const remaining = (activePatches.current.get(localId) ?? []).filter(
          (candidate) => candidate !== patch
        )
        if (remaining.length > 0) {
          activePatches.current.set(localId, remaining)
        } else {
          activePatches.current.delete(localId)
        }
      }

      beginWrite()
      void page
        .updateByKey({ properties })
        .then((result) => {
          clearActivePatch()
          if (result.status === "success") {
            const base = baselines.current.get(localId)
            if (base) baselines.current.set(localId, { ...base, ...patch })
            endWrite(true)
          } else {
            console.warn("whiteboard: update failed", result.error)
            revertPatch(localId, patch)
            endWrite(false)
          }
        })
        .catch(() => {
          clearActivePatch()
          revertPatch(localId, patch)
          endWrite(false)
        })
    },
    [beginWrite, endWrite, revertPatch]
  )

  const createItem = useCallback(
    (item: Omit<BoardItem, "id">): string => {
      const localId = `local-${++localSeq.current}`
      const withTitle = { ...item, title: item.title || autoLabel(item.type) }
      optimisticCreates.current.add(localId)
      setLocal((prev) => [...(prev ?? []), { ...withTitle, id: localId }])
      pageIds.current.set(localId, "")

      const removeOptimistic = () => {
        optimisticCreates.current.delete(localId)
        pageIds.current.delete(localId)
        pending.current.delete(localId)
        const t = timers.current.get(localId)
        if (t) clearTimeout(t)
        timers.current.delete(localId)
        setLocal((prev) =>
          prev ? prev.filter((it) => it.id !== localId) : prev
        )
      }

      beginWrite()
      void createPage({
        parent: { type: "data_source_key", dataSourceKey: DATA_SOURCE_KEY },
        properties: patchToProperties(withTitle),
      })
        .then((result) => {
          if (result.status === "success") {
            if (pageIds.current.has(localId)) {
              const pageKey = result.page.getKey()
              pageIds.current.set(localId, pageKey)
              pageCache.current.set(pageKey, result.page)
              baselines.current.set(localId, { ...withTitle, id: localId })
            } else {
              // Item was deleted while the create was in flight.
              void result.page.archive()
            }
            endWrite(true)
          } else {
            console.warn("whiteboard: create failed", result.error)
            removeOptimistic()
            endWrite(false)
          }
        })
        .catch(() => {
          removeOptimistic()
          endWrite(false)
        })
      return localId
    },
    [beginWrite, endWrite]
  )

  const updateItem = useCallback(
    (id: string, patch: ItemPatch) => {
      setLocal((prev) =>
        prev
          ? prev.map((it) => (it.id === id ? { ...it, ...patch } : it))
          : prev
      )
      pending.current.set(id, { ...pending.current.get(id), ...patch })
      const existing = timers.current.get(id)
      if (existing) clearTimeout(existing)
      timers.current.set(
        id,
        setTimeout(() => flush(id), WRITE_DEBOUNCE_MS)
      )
    },
    [flush]
  )

  const deleteItem = useCallback(
    (id: string) => {
      setLocal((prev) => (prev ? prev.filter((it) => it.id !== id) : prev))
      const timer = timers.current.get(id)
      if (timer) clearTimeout(timer)
      timers.current.delete(id)
      pending.current.delete(id)
      activePatches.current.delete(id)
      optimisticCreates.current.delete(id)
      baselines.current.delete(id)
      const pageId = pageIds.current.get(id)
      pageIds.current.delete(id)
      if (pageId) {
        const page = pageCache.current.get(pageId)
        if (!page) return
        pageCache.current.delete(pageId)
        beginWrite()
        void page
          .archive()
          .then((result) => {
            // A row already gone (deleted twice, or removed in Notion)
            // is fine — local state is already reconciled. Stay quiet.
            if (result.status !== "success") {
              console.warn("whiteboard: delete failed", result.error)
            }
            endWrite(true)
          })
          .catch(() => endWrite(true))
      }
    },
    [beginWrite, endWrite]
  )

  return {
    items: local ?? [],
    isLoading: local === null && !hasLoadError,
    loadError: hasLoadError
      ? "Couldn't load the whiteboard database. Map a database to the “items” key in the block settings."
      : null,
    setupIssues: validateWhiteboardBindings(snapshot?.propertyIdsByKey ?? {}),
    saveState,
    createItem,
    updateItem,
    deleteItem,
  }
}
