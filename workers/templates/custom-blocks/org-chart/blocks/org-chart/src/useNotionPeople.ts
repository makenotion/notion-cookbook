import { useMemo } from "react"
import { useLoadedDataSource } from "./useLoadedDataSource"
import type { OrgDataState, Person, PersonIcon } from "./types"

const DATA_SOURCE_KEY = "people"
const DATA_SOURCE_OPTIONS = { limit: 999 }

/** Loads the people query and its page snapshots for the org chart. */
export function useNotionPeople(): OrgDataState {
  const dataSource = useLoadedDataSource(DATA_SOURCE_KEY, DATA_SOURCE_OPTIONS)
  return useMemo<OrgDataState>(() => {
    if (dataSource.status === "loading") return { status: "loading" }
    if (dataSource.status === "error") return { status: "unbound" }

    const { items, propertyIdsByKey, isLoading } = dataSource.value
    if (isLoading && items.length === 0) return { status: "loading" }
    if (
      !propertyIdsByKey.name ||
      !propertyIdsByKey.role ||
      !propertyIdsByKey.reportsTo
    ) {
      return { status: "unbound" }
    }

    const people: Person[] = []
    for (const { data: item } of items) {
      const nameProperty = item.getPropertyByKey("name")
      const name =
        nameProperty?.type === "title"
          ? nameProperty.title
              .map((segment) => segment["plain_text"])
              .filter((part): part is string => typeof part === "string")
              .join("")
              .trim()
          : ""
      if (name === "") continue
      const roleProperty = item.getPropertyByKey("role")
      const role =
        roleProperty?.type === "rich_text"
          ? roleProperty.rich_text
              .map((segment) => segment["plain_text"])
              .filter((part): part is string => typeof part === "string")
              .join("")
              .trim()
          : ""
      const relationProperty = item.getPropertyByKey("reportsTo")
      const managerIds =
        relationProperty?.type === "relation"
          ? relationProperty.relation.map((pointer) => pointer.id)
          : []
      people.push({
        id: item.pageKey,
        name,
        role,
        managerIds,
        icon: toPersonIcon(item.icon) ?? undefined,
      })
    }
    if (people.length === 0) return { status: "empty" }
    return { status: "ready", people }
  }, [dataSource])
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
