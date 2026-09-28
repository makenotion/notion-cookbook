import type { Notion } from "../../lib/props.js"
import type { DataSourceIds } from "./ingest.js"

// The Apps SDK cannot declare relation properties yet, so ingest adds these
// two-way relations to the provisioned data sources on first run. The text
// join keys stay authoritative; the relations are for navigating in Notion.
type RelationSpec = {
  from: keyof DataSourceIds
  name: string
  to: keyof DataSourceIds
  syncedName: string
}

export const RELATIONS: readonly RelationSpec[] = [
  { from: "meetings", name: "Attendees", to: "people", syncedName: "Meetings" },
  {
    from: "meetings",
    name: "Companies",
    to: "companies",
    syncedName: "Meetings",
  },
  { from: "people", name: "Company", to: "companies", syncedName: "People" },
]

/** Add any missing relation properties. Returns the names it created. */
export async function ensureRelations(
  notion: Notion,
  ids: DataSourceIds
): Promise<string[]> {
  const created: string[] = []
  const existing = new Map<string, Set<string>>()
  const propertyNames = async (key: keyof DataSourceIds) => {
    const cached = existing.get(key)
    if (cached) return cached
    const source = await notion.dataSources.retrieve({
      data_source_id: ids[key],
    })
    const names = new Set(Object.keys(source.properties))
    existing.set(key, names)
    return names
  }

  for (const spec of RELATIONS) {
    const fromNames = await propertyNames(spec.from)
    if (fromNames.has(spec.name)) continue
    await notion.dataSources.update({
      data_source_id: ids[spec.from],
      properties: {
        [spec.name]: {
          relation: {
            data_source_id: ids[spec.to],
            type: "dual_property",
            dual_property: { synced_property_name: spec.syncedName },
          },
        },
      },
    })
    fromNames.add(spec.name)
    created.push(`${spec.from}.${spec.name}`)
  }
  return created
}
