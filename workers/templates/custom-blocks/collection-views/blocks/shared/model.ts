import { pages } from "@notionhq/custom-blocks"
import type { ActionResult } from "./actions"
import type {
  DataSourceQueryOptions,
  NotionDataSourcePage,
  NotionDataSourceValue,
  NotionPagePropertyInputMap,
  NotionPropertySchema,
  NotionDataSourcePageUpdateArgs,
  OpenPageMode,
} from "@notionhq/custom-blocks"

export type View = "table" | "board" | "gallery" | "list" | "feed"
export type Sort = "name" | "due" | "rating"
export type Query = {
  search: string
  stage: string
  sort: Sort
  descending: boolean
  limit: number
}
export type Item = {
  row: {
    id: string
    update: (args: NotionDataSourcePageUpdateArgs) => Promise<ActionResult>
    open: (mode: OpenPageMode) => Promise<ActionResult>
  }
  name: string
  stage: string
  summary: string
  due: string
  owners: string[]
  authors: string[]
  createdAt: string | undefined
  loadImage?: (refresh: boolean) => Promise<string | undefined>
  rating: number | undefined
}
export type Stage = { name: string; color: string }
export type StageTheme =
  | "gray"
  | "brown"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "red"
export const MAX_ROWS = 999

export function queryOptions(
  query: Query,
  stageType: "select" | "status"
): DataSourceQueryOptions {
  const filter = []
  if (query.search.trim())
    filter.push({ key: "name", title: { contains: query.search.trim() } })
  if (query.stage)
    filter.push(
      stageType === "status"
        ? { key: "stage", status: { equals: query.stage } }
        : { key: "stage", select: { equals: query.stage } }
    )
  return {
    limit: Math.min(MAX_ROWS, query.limit),
    sorts: [
      {
        key: query.sort,
        direction: query.descending ? "descending" : "ascending",
      },
    ],
    filter: filter.length ? { and: filter } : undefined,
  }
}

export function readItem(row: NotionDataSourcePage): Item {
  const p = row.propertiesByKey
  const due = p.due
  const owners = p.owner
  const creator = row.propertiesById.created_by
  const created = row.propertiesById.created_time
  return {
    row: {
      id: row.id,
      update: row.update,
      open: (mode) => pages.open(row.id, { mode }),
    },
    name: text(p.name) || "Untitled",
    stage: text(p.stage),
    summary: text(p.summary),
    due:
      due && typeof due === "object" && !Array.isArray(due)
        ? (due.start_date ?? "")
        : "",
    owners: Array.isArray(owners)
      ? owners.flatMap((owner) => (typeof owner === "object" ? [owner.id] : []))
      : [],
    authors: Array.isArray(creator)
      ? creator.flatMap((value) =>
          typeof value === "object" ? [value.id] : []
        )
      : [],
    createdAt: readCreatedAt(created),
    rating:
      typeof p.rating === "number" && Number.isFinite(p.rating)
        ? p.rating
        : undefined,
  }
}

export function stagesFor(
  schema: NotionPropertySchema | undefined,
  items: Item[]
): Stage[] {
  const names = new Map<string, string>()
  if (schema?.type === "select" || schema?.type === "status") {
    for (const option of schema.options ?? [])
      names.set(option.name, option.color ?? "default")
  }
  for (const item of items)
    if (item.stage && !names.has(item.stage)) names.set(item.stage, "default")
  return [
    ...Array.from(names, ([name, color]) => ({ name, color })),
    { name: "", color: "default" },
  ]
}

export function stageColorsFor(
  stages: Stage[]
): ReadonlyMap<string, StageTheme> {
  return new Map(stages.map(({ name, color }) => [name, stageTheme(color)]))
}

export function stageProperty(
  stage: string,
  type: "select" | "status"
): NotionPagePropertyInputMap {
  if (type === "status")
    return { stage: { type, status: stage ? { name: stage } : null } }
  return { stage: { type, select: stage ? { name: stage } : null } }
}

export function titleProperty(name: string): NotionPagePropertyInputMap {
  return {
    name: { type: "title", title: [{ type: "text", text: { content: name } }] },
  }
}

export function nextLimit(limit: number): number {
  return Math.min(MAX_ROWS, limit + 100)
}

export function imageUrl(
  value: NotionDataSourceValue | undefined
): string | undefined {
  // Files query values are names; image URLs come from page metadata.
  if (typeof value !== "string") return undefined
  try {
    const url = new URL(value.trim())
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}

function text(value: NotionDataSourceValue | undefined): string {
  return typeof value === "string" ? value : ""
}

function stageTheme(color: string): StageTheme {
  const theme = color.replace(/_background$/, "")
  switch (theme) {
    case "gray":
    case "brown":
    case "orange":
    case "yellow":
    case "green":
    case "blue":
    case "purple":
    case "pink":
    case "red":
      return theme
    default:
      return "gray"
  }
}

function readCreatedAt(
  value: NotionDataSourceValue | undefined
): string | undefined {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined
  if (
    (value.type === "datetime" || value.type === "datetimerange") &&
    value.time_zone === "UTC"
  )
    return `${value.start_date}T${value.start_time}Z`
  return value.start_date
}
