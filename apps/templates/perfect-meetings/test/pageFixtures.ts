import type {
  NotionDateInput,
  NotionPagePropertyValue,
} from "@notionhq/apps/custom-blocks"
import type { PageRow } from "../blocks/main_ui/meeting.js"

type PropertyFixture = string | NotionDateInput | NotionPagePropertyValue | null
export type PageProperties = Record<string, PropertyFixture>

export function pageRow(
  id: string,
  values: PageProperties,
  metadata: {
    created_time?: string | null
    last_edited_time?: string | null
  } = {}
): PageRow & { properties: Record<string, NotionPagePropertyValue | null> } {
  const properties: Record<string, NotionPagePropertyValue | null> = {}
  for (const [key, value] of Object.entries(values)) {
    properties[key] = propertyValue(key, value)
  }
  return {
    id,
    properties,
    created_time: metadata.created_time ?? null,
    last_edited_time: metadata.last_edited_time ?? null,
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
