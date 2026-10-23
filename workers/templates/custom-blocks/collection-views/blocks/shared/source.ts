import { useEffect, useRef, useState } from "react"
import { pages, users } from "@notionhq/custom-blocks"
import type {
  NotionPagePropertyInputMap,
  NotionPropertySchema,
  NotionPageId,
  NotionUserId,
} from "@notionhq/custom-blocks"
import { useDataSource } from "@notionhq/custom-blocks/react"
import type { ActionResult } from "./actions"
import { imageUrl, queryOptions, readItem } from "./model"
import type { Item, Query } from "./model"

export type CollectionSource = {
  items: Item[]
  propertyIdsByKey: { [key: string]: string | undefined }
  propertySchemasByKey: { [key: string]: NotionPropertySchema | undefined }
  isLoading: boolean
  hasMore: boolean
  error: { message: string } | undefined
  peopleError: string | undefined
  owners: ReadonlyMap<string, string>
  create: (properties: NotionPagePropertyInputMap) => Promise<ActionResult>
}
export type CollectionSourceHook = (
  query: Query,
  stageType: "select" | "status",
  includeAuthors: boolean
) => CollectionSource

export function useNotionSource(
  query: Query,
  stageType: "select" | "status",
  includeAuthors: boolean
): CollectionSource {
  const snapshot = useDataSource("items", queryOptions(query, stageType))
  const imageCache = useRef(
    new Map<
      string,
      { value: string; load: (refresh: boolean) => Promise<string | undefined> }
    >()
  )
  const items = snapshot.items.map(readItem)
  const peopleCache = useRef(new Map<string, Promise<string>>())
  const [owners, setOwners] = useState<Map<string, string>>(() => new Map())
  const [peopleError, setPeopleError] = useState<string>()
  const peopleKey = [
    ...new Set(
      items.flatMap((item) => [
        ...(includeAuthors ? item.authors : []),
        ...item.owners,
      ])
    ),
  ]
    .sort()
    .join(",")
  useEffect(() => {
    let active = true
    const queue = peopleKey ? peopleKey.split(",") : []
    setPeopleError(undefined)
    async function resolveNext() {
      for (;;) {
        const id = queue.shift()
        if (!id || !active) return
        let request = peopleCache.current.get(id)
        if (!request) {
          request = loadPerson(id)
          peopleCache.current.set(id, request)
        }
        try {
          const name = await request
          if (active) setOwners((current) => new Map(current).set(id, name))
        } catch (reason: unknown) {
          if (active)
            setPeopleError(
              reason instanceof Error ? reason.message : "request failed"
            )
        }
      }
    }
    // Resolve each referenced person once, with at most four requests at a time.
    for (let index = 0; index < 4; index++) void resolveNext()
    return () => {
      active = false
    }
  }, [peopleKey])
  return {
    ...snapshot,
    error: snapshot.error,
    items: snapshot.items.map((row) => {
      const item = readItem(row)
      const propertyId = snapshot.propertyIdsByKey.image
      if (!propertyId) return item
      // Queries omit uploaded Files. Explicit image previews need a page read;
      // key its cache by the last edit as well as the flattened query value.
      const value = JSON.stringify([
        propertyId,
        row.propertiesByKey.image,
        row.propertiesById.last_edited_time,
      ])
      const cached = imageCache.current.get(row.id)
      if (cached?.value === value) return { ...item, loadImage: cached.load }
      let request: Promise<string | undefined> | undefined
      const load = (refresh: boolean) => {
        if (!request || refresh) request = loadFileImage(row.id, propertyId)
        return request
      }
      imageCache.current.set(row.id, { value, load })
      return { ...item, loadImage: load }
    }),
    owners,
    peopleError,
    create: (properties) =>
      pages.create({
        parent: { type: "data_source_key", key: "items" },
        properties,
      }),
  }
}

async function loadFileImage(
  pageId: NotionPageId,
  propertyId: string
): Promise<string | undefined> {
  const result = await pages.get(pageId)
  if (result.status === "error") throw new Error(result.error.message)
  const property = result.page.properties[propertyId]
  if (property?.type !== "files") return undefined
  for (const file of property.files) {
    const url = imageUrl(
      file.type === "external" ? file.external.url : file.file.url
    )
    if (url) return url
  }
  return undefined
}

async function loadPerson(id: string): Promise<string> {
  if (!isUserId(id)) throw new Error("Invalid person ID in database properties")
  const result = await users.get(id)
  if (result.status === "error") throw new Error(result.error.message)
  return result.user.name ?? `Person ${id.slice(0, 8)}`
}

function isUserId(value: string): value is NotionUserId {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value
  )
}
