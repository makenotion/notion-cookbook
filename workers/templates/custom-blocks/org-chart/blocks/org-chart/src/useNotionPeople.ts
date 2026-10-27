import { useMemo } from "react"
import { useDataSource } from "./useDataSource"
import type { OrgDataState, Person, PersonIcon } from "./types"

const DATA_SOURCE_KEY = "people"
const DATA_SOURCE_OPTIONS = { limit: 999 }

/**
 * Real data layer: reads the `people` data source and its page icons.
 */
export function useNotionPeople(): OrgDataState {
  const { items, isLoading, error, propertyIdsByKey } = useDataSource(
    DATA_SOURCE_KEY,
    DATA_SOURCE_OPTIONS
  )
  return useMemo<OrgDataState>(() => {
    if (isLoading && items.length === 0) return { status: "loading" }
    if (error) return { status: "unbound" }
    if (
      !propertyIdsByKey.name ||
      !propertyIdsByKey.role ||
      !propertyIdsByKey.reportsTo
    ) {
      return { status: "unbound" }
    }

    const people: Person[] = []
    for (const item of items) {
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
        id: item.id,
        name,
        role,
        managerIds,
        icon: toPersonIcon(item.icon) ?? undefined,
      })
    }
    if (people.length === 0) return { status: "empty" }
    return { status: "ready", people }
  }, [items, isLoading, error, propertyIdsByKey])
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
