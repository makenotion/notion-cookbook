import { useMemo } from "react"
import { NotionDataSource } from "@notionhq/custom-blocks/data-sources"
import { useQuerySubscription } from "@notionhq/custom-blocks/react"
import type { OrgDataState, Person, PersonIcon } from "./types"

const PEOPLE_QUERY = NotionDataSource.fromKey("people").createQuery()

/**
 * Real data layer: reads the `people` data source and its page icons.
 */
export function useNotionPeople(): OrgDataState {
  const result = useQuerySubscription(PEOPLE_QUERY, { limit: 999 })
  return useMemo<OrgDataState>(() => {
    if (result.status === "loading") return { status: "loading" }
    if (result.status === "error") return { status: "unbound" }
    const { items, isLoading, propertyIdsByKey } = result.value
    if (isLoading && items.length === 0) return { status: "loading" }
    if (
      !propertyIdsByKey.name ||
      !propertyIdsByKey.role ||
      !propertyIdsByKey.reportsTo
    ) {
      return { status: "unbound" }
    }

    const people: Person[] = []
    for (const { data } of items) {
      const nameProperty = data.getPropertyByKey("name")
      const name =
        nameProperty?.type === "title"
          ? nameProperty.title.map(readTextSegment).join("").trim()
          : ""
      if (name === "") continue
      const roleProperty = data.getPropertyByKey("role")
      const role =
        roleProperty?.type === "rich_text"
          ? roleProperty.rich_text.map(readTextSegment).join("").trim()
          : ""
      const relationProperty = data.getPropertyByKey("reportsTo")
      const managerIds =
        relationProperty?.type === "relation"
          ? relationProperty.relation.map((pointer) => pointer.id)
          : []
      people.push({
        id: data.pageKey,
        name,
        role,
        managerIds,
        icon: toPersonIcon(data.icon) ?? undefined,
      })
    }
    if (people.length === 0) return { status: "empty" }
    return { status: "ready", people }
  }, [result])
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
