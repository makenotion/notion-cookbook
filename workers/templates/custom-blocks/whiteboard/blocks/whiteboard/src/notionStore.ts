import { useCallback, useEffect, useRef, useState } from "react"
import { pages } from "@notionhq/custom-blocks"
import type {
  NotionDataSourcePage,
  NotionPagePropertyInputValue,
} from "@notionhq/custom-blocks"
import { useDataSource } from "@notionhq/custom-blocks/react"
import type { BoardItem, WhiteboardStore, SaveState } from "./model"
import {
  autoLabel,
  encodePoints,
  isItemColor,
  isItemType,
  parsePoints,
} from "./model"
import { validateWhiteboardSchema } from "./schema"

const DATA_SOURCE_KEY = "items"
const WRITE_DEBOUNCE_MS = 500
/** Notion rich text segments cap at 2000 chars; stay under it. */
const TEXT_CHUNK = 1900

type ItemPatch = Partial<Omit<BoardItem, "id">>

function rowToItem(row: NotionDataSourcePage): BoardItem | null {
  const p = row.propertiesByKey
  const type = p.type
  if (!isItemType(type)) return null
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback
  return {
    id: row.id,
    type,
    title: typeof p.title === "string" ? p.title : "",
    color: isItemColor(p.color)
      ? p.color
      : type === "sticky"
        ? "yellow"
        : "gray",
    x: num(p.x, 0),
    y: num(p.y, 0),
    width: num(p.width, type === "sticky" ? 160 : 0),
    height: num(p.height, type === "sticky" ? 160 : 0),
    points: parsePoints(typeof p.points === "string" ? p.points : ""),
    strokeWidth: num(p.strokeWidth, 2),
    z: num(p.z, 0),
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
  const {
    items: rows,
    isLoading,
    error,
    collectionSchema,
    propertyIdsByKey,
    propertySchemasByKey,
  } = useDataSource(DATA_SOURCE_KEY, { limit: 999 })

  const [local, setLocal] = useState<BoardItem[] | null>(null)
  const [saveState, setSaveState] = useState<SaveState>("idle")
  const queryStarted = useRef(false)
  if (isLoading) queryStarted.current = true

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
  const propertyIdsRef = useRef(propertyIdsByKey)
  propertyIdsRef.current = propertyIdsByKey
  const localSeq = useRef(0)
  // useDataSource resolves fresh row wrapper objects on every render. Depend on
  // their serializable board values so local reconciliation only runs when the
  // actual database snapshot changes.
  const rowsRevision = rows
    .map((row) => JSON.stringify(rowToItem(row)))
    .join("\n")

  // The SDK exposes an empty, non-loading snapshot before its query effect runs.
  // Wait until we have observed the query cycle (or actual rows), then reconcile
  // every live snapshot while preserving local creates and unconfirmed writes.
  useEffect(() => {
    if (isLoading || error || (!queryStarted.current && rows.length === 0)) return

    const localIdByPageId = new Map<string, string>()
    for (const [localId, pageId] of pageIds.current) {
      if (pageId) localIdByPageId.set(pageId, localId)
    }

    const synced: BoardItem[] = []
    const syncedIds = new Set<string>()
    for (const row of rows) {
      const remoteItem = rowToItem(row)
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
  }, [isLoading, error, rowsRevision])

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

      const bySemanticKey = patchToProperties(patch)
      // pages.update requires raw property ids; resolve via the bound schema.
      const properties: Record<
        string,
        NotionPagePropertyInputValue & { id: string }
      > = {}
      for (const [key, value] of Object.entries(bySemanticKey)) {
        const rawId = propertyIdsRef.current[key]
        if (rawId) properties[rawId] = { ...value, id: rawId }
      }
      if (Object.keys(properties).length === 0) return

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
      void pages
        .update({
          pageId: pageId as Parameters<typeof pages.get>[0],
          properties,
        })
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
      void pages
        .create({
          parent: { type: "data_source_key", key: DATA_SOURCE_KEY },
          properties: patchToProperties(withTitle),
        })
        .then((result) => {
          if (result.status === "success") {
            if (pageIds.current.has(localId)) {
              pageIds.current.set(localId, result.page.id)
              baselines.current.set(localId, { ...withTitle, id: localId })
            } else {
              // Item was deleted while the create was in flight.
              void pages.delete(result.page.id)
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
        beginWrite()
        void pages
          .delete(pageId as Parameters<typeof pages.get>[0])
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
    isLoading: local === null && !error,
    loadError: error
      ? "Couldn't load the whiteboard database. Map a database to the “items” key in the block settings."
      : null,
    setupIssues: collectionSchema
      ? validateWhiteboardSchema(propertySchemasByKey)
      : [],
    saveState,
    createItem,
    updateItem,
    deleteItem,
  }
}
