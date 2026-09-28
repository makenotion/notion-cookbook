import type { CapabilityContext } from "@notionhq/apps/context"

export type Notion = CapabilityContext["notion"]
export type PropertyMap = NonNullable<
  Parameters<Notion["pages"]["create"]>[0]["properties"]
>
type PropertyValue = PropertyMap[string]

const MAX_TEXT = 2000

// ---- Writers --------------------------------------------------------------

export const prop = {
  title: (value: string): PropertyValue => ({
    title: [{ text: { content: value.slice(0, MAX_TEXT) } }],
  }),
  text: (value: string): PropertyValue => ({
    rich_text: value ? [{ text: { content: value.slice(0, MAX_TEXT) } }] : [],
  }),
  url: (value: string | null): PropertyValue => ({ url: value }),
  email: (value: string): PropertyValue => ({ email: value }),
  select: (name: string): PropertyValue => ({ select: { name } }),
  checkbox: (value: boolean): PropertyValue => ({ checkbox: value }),
  relation: (ids: readonly string[]): PropertyValue => ({
    relation: ids.map((id) => ({ id })),
  }),
  date: (start: string, end: string | null = null): PropertyValue => ({
    date: { start, end },
  }),
}

// ---- Readers --------------------------------------------------------------

type RawProperties = Record<string, unknown>

function field(
  properties: RawProperties,
  name: string
): Record<string, unknown> | undefined {
  const value = properties[name]
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function plainText(items: unknown): string {
  if (!Array.isArray(items)) return ""
  return items
    .map((item) => (item as { plain_text?: string }).plain_text ?? "")
    .join("")
}

export const read = {
  title: (p: RawProperties, name: string) => plainText(field(p, name)?.title),
  text: (p: RawProperties, name: string) =>
    plainText(field(p, name)?.rich_text),
  url: (p: RawProperties, name: string) =>
    (field(p, name)?.url as string | null | undefined) ?? null,
  email: (p: RawProperties, name: string) =>
    (field(p, name)?.email as string | null | undefined) ?? null,
  select: (p: RawProperties, name: string) =>
    (field(p, name)?.select as { name?: string } | null | undefined)?.name ??
    null,
  checkbox: (p: RawProperties, name: string) =>
    field(p, name)?.checkbox === true,
  relation: (p: RawProperties, name: string) => {
    const items = field(p, name)?.relation
    return Array.isArray(items)
      ? items.map((item) => (item as { id: string }).id)
      : []
  },
  date: (p: RawProperties, name: string) => {
    const value = field(p, name)?.date as
      | { start?: string; end?: string | null }
      | null
      | undefined
    return value?.start ? { start: value.start, end: value.end ?? null } : null
  },
}

export type PageRecord = { id: string; properties: RawProperties }

export function asPage(value: unknown): PageRecord {
  const page = value as { id?: unknown; properties?: unknown }
  if (
    typeof page.id !== "string" ||
    typeof page.properties !== "object" ||
    page.properties === null
  ) {
    throw new Error("Notion response was not a full page")
  }
  return { id: page.id, properties: page.properties as RawProperties }
}

/** Query a data source for pages whose text-like property equals a value. */
export async function findOne(
  notion: Notion,
  dataSourceId: string,
  filter: Parameters<Notion["dataSources"]["query"]>[0]["filter"]
): Promise<PageRecord | null> {
  const response = await notion.dataSources.query({
    data_source_id: dataSourceId,
    filter,
    page_size: 1,
  })
  const first = response.results[0]
  return first ? asPage(first) : null
}

/** Read every page in a data source query, following cursors. */
export async function queryAll(
  notion: Notion,
  args: Parameters<Notion["dataSources"]["query"]>[0]
): Promise<PageRecord[]> {
  const pages: PageRecord[] = []
  let cursor: string | undefined
  do {
    const response = await notion.dataSources.query({
      ...args,
      start_cursor: cursor,
      page_size: 100,
    })
    for (const result of response.results) {
      if ((result as { object?: string }).object === "page")
        pages.push(asPage(result))
    }
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined
  } while (cursor)
  return pages
}
