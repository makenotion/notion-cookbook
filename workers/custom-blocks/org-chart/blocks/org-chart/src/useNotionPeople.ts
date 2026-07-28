import { useEffect, useMemo, useRef, useState } from "react"
import { pages } from "@notionhq/custom-blocks"
import { useDataSource } from "@notionhq/custom-blocks/react"
import type { OrgDataState, Person, PersonIcon } from "./types"

const DATA_SOURCE_KEY = "people"
const ICON_FETCH_CONCURRENCY = 5

/**
 * Real data layer: reads the `people` data source and lazily resolves each
 * row's page icon (rows from useDataSource don't carry icons).
 */
export function useNotionPeople(): OrgDataState {
  const { items, isLoading, error } = useDataSource(DATA_SOURCE_KEY, {
    limit: 999,
  })
  const [icons, setIcons] = useState<ReadonlyMap<string, PersonIcon | null>>(
    new Map()
  )
  const requestedRef = useRef<Set<string>>(new Set())

  const ids = items.map((item) => item.id).join("\n")

  useEffect(() => {
    let cancelled = false
    const pending = items
      .map((item) => item.id)
      .filter((id) => !requestedRef.current.has(id))
    if (pending.length === 0) return
    for (const id of pending) requestedRef.current.add(id)

    const queue = [...pending]
    const found = new Map<string, PersonIcon | null>()
    async function drain(): Promise<void> {
      for (;;) {
        const id = queue.shift()
        if (id === undefined || cancelled) return
        try {
          const result = await pages.get(id as Parameters<typeof pages.get>[0])
          if (result.status === "success") {
            found.set(id, toPersonIcon(result.page.icon))
          } else {
            found.set(id, null)
          }
        } catch {
          found.set(id, null)
        }
      }
    }
    void Promise.all(
      Array.from({ length: ICON_FETCH_CONCURRENCY }, () => drain())
    ).then(() => {
      if (cancelled || found.size === 0) return
      setIcons((prev) => {
        const next = new Map(prev)
        for (const [id, icon] of found) next.set(id, icon)
        return next
      })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids])

  return useMemo<OrgDataState>(() => {
    if (error) return { status: "unbound" }
    if (isLoading && items.length === 0) return { status: "loading" }

    const people: Person[] = []
    for (const item of items) {
      const props = item.propertiesByKey
      const name = typeof props.name === "string" ? props.name.trim() : ""
      if (name === "") continue
      const role = typeof props.role === "string" ? props.role.trim() : ""
      const relation = props.reportsTo
      const managerIds = Array.isArray(relation)
        ? relation
            .map((pointer) =>
              pointer !== null &&
              typeof pointer === "object" &&
              "id" in pointer &&
              typeof pointer.id === "string"
                ? pointer.id
                : null
            )
            .filter((id): id is string => id !== null)
        : []
      people.push({
        id: item.id,
        name,
        role,
        managerIds,
        icon: icons.get(item.id) ?? undefined,
      })
    }
    if (people.length === 0) return { status: "empty" }
    return { status: "ready", people }
  }, [items, isLoading, error, icons])
}

type NotionPageIconLike =
  | { type: "emoji"; emoji: string }
  | { type: "external"; external: { url: string } }
  | { type: "file"; file: { url: string } }
  | { type: string }
  | null
  | undefined

function toPersonIcon(icon: NotionPageIconLike): PersonIcon | null {
  if (!icon) return null
  if (icon.type === "emoji" && "emoji" in icon) {
    return { type: "emoji", emoji: icon.emoji }
  }
  if (icon.type === "external" && "external" in icon) {
    return { type: "url", url: icon.external.url }
  }
  if (icon.type === "file" && "file" in icon) {
    return { type: "url", url: icon.file.url }
  }
  return null
}
