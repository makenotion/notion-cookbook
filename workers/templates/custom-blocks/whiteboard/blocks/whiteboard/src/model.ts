/** Shared whiteboard data model + store contract. */

export type ItemType = "sticky" | "stroke" | "line" | "arrow"

export type ItemColor =
  | "yellow"
  | "blue"
  | "pink"
  | "green"
  | "purple"
  | "red"
  | "gray"

export const ITEM_COLORS: ItemColor[] = [
  "yellow",
  "blue",
  "pink",
  "green",
  "purple",
  "red",
  "gray",
]

/** Sticky fill palette (translucent ramps flip correctly in dark mode). */
export const STICKY_COLORS: ItemColor[] = [
  "yellow",
  "blue",
  "pink",
  "green",
  "purple",
  "red",
  "gray",
]

/** Ink palette for pen / line / arrow. Gray is the near-ink default. */
export const INK_COLORS: ItemColor[] = [
  "gray",
  "blue",
  "red",
  "green",
  "purple",
]

export type Point = [number, number]

export type BoardItem = {
  id: string
  type: ItemType
  /** Sticky text, or auto label ("Stroke", "Line", "Arrow"). */
  title: string
  color: ItemColor
  /** Canvas position: top-left for stickies, bounding origin for strokes. */
  x: number
  y: number
  width: number
  height: number
  /** Points relative to (x, y). Empty for stickies. */
  points: Point[]
  strokeWidth: number
  /** Stacking order — higher renders on top. */
  z: number
}

export type SaveState = "idle" | "saving" | "saved" | "error"

export type WhiteboardSetupIssue = {
  property: string
  message: string
}

/** Data-layer contract shared by the Notion-backed and mock stores. */
export type WhiteboardStore = {
  items: BoardItem[]
  isLoading: boolean
  /** Human-readable load error (e.g. data source not mapped), if any. */
  loadError: string | null
  /** Actionable problems with the mapped database schema. */
  setupIssues: WhiteboardSetupIssue[]
  saveState: SaveState
  /** Optimistic create; resolves local state immediately. Returns the local id. */
  createItem: (item: Omit<BoardItem, "id">) => string
  /** Optimistic update; persistence is debounced (~500ms). */
  updateItem: (id: string, patch: Partial<Omit<BoardItem, "id">>) => void
  /** Optimistic delete; persists immediately. */
  deleteItem: (id: string) => void
}

export function isItemType(value: unknown): value is ItemType {
  return (
    value === "sticky" ||
    value === "stroke" ||
    value === "line" ||
    value === "arrow"
  )
}

export function isItemColor(value: unknown): value is ItemColor {
  return typeof value === "string" && (ITEM_COLORS as string[]).includes(value)
}

export function autoLabel(type: ItemType): string {
  switch (type) {
    case "stroke":
      return "Stroke"
    case "line":
      return "Line"
    case "arrow":
      return "Arrow"
    case "sticky":
      return ""
  }
}

/** Parse a JSON-encoded point array; tolerate malformed data. */
export function parsePoints(raw: string): Point[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: Point[] = []
    for (const entry of parsed) {
      if (
        Array.isArray(entry) &&
        entry.length >= 2 &&
        typeof entry[0] === "number" &&
        typeof entry[1] === "number" &&
        Number.isFinite(entry[0]) &&
        Number.isFinite(entry[1])
      ) {
        out.push([entry[0], entry[1]])
      }
    }
    return out
  } catch {
    return []
  }
}

export function encodePoints(points: Point[]): string {
  return JSON.stringify(points.map(([x, y]) => [Math.round(x), Math.round(y)]))
}
