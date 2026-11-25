import type { NotionDateInput } from "@notionhq/custom-blocks"
import type { NotionPagePropertyValue } from "@notionhq/custom-blocks/pages"
import type { PageRow } from "../blocks/main_ui/meeting.js"

type PropertyFixture = string | NotionDateInput | NotionPagePropertyValue | null
export type PageProperties = Record<string, PropertyFixture>

export function pageRow(
  pageKey: string,
  values: PageProperties,
  metadata: {
    createdTime?: string | null
    lastEditedTime?: string | null
  } = {}
): PageRow & { properties: Record<string, NotionPagePropertyValue | null> } {
  const properties: Record<string, NotionPagePropertyValue | null> = {}
  for (const [key, value] of Object.entries(values)) {
    properties[key] = propertyValue(key, value)
  }
  return {
    pageKey,
    properties,
    createdTime: metadata.createdTime ?? null,
    lastEditedTime: metadata.lastEditedTime ?? null,
    getPropertyByKey: (key) => properties[key] ?? null,
  }
}

export function propertyValue(
  id: string,
  value: PropertyFixture
): NotionPagePropertyValue | null {
  if (typeof value === "string") {
    return { id, type: "rich_text", rich_text: [{ plain_text: value }] }
  }
  if (value && "start" in value) {
    return { id, type: "date", date: value }
  }
  return value
}
