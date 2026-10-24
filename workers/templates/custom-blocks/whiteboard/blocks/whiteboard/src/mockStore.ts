import { useCallback, useRef, useState } from "react"
import type { BoardItem, SaveState, WhiteboardStore } from "./model"

/** Seed data: 3 stickies, one freehand squiggle, one arrow connecting two stickies. */
const SEED: BoardItem[] = [
  {
    id: "mock-1",
    type: "sticky",
    title: "Ship the demo build Friday",
    color: "yellow",
    x: 56,
    y: 64,
    width: 160,
    height: 160,
    points: [],
    strokeWidth: 2,
    z: 1,
  },
  {
    id: "mock-2",
    type: "sticky",
    title: "Ask Maya about the API rate limits",
    color: "blue",
    x: 318,
    y: 212,
    width: 160,
    height: 160,
    points: [],
    strokeWidth: 2,
    z: 2,
  },
  {
    id: "mock-3",
    type: "sticky",
    title: "Onboarding copy — cut it in half",
    color: "pink",
    x: 96,
    y: 292,
    width: 160,
    height: 160,
    points: [],
    strokeWidth: 2,
    z: 3,
  },
  {
    id: "mock-4",
    type: "stroke",
    title: "Stroke",
    color: "gray",
    x: 300,
    y: 48,
    width: 190,
    height: 84,
    points: [
      [0, 62],
      [14, 30],
      [30, 10],
      [44, 2],
      [56, 8],
      [62, 26],
      [64, 50],
      [72, 70],
      [88, 78],
      [106, 72],
      [120, 52],
      [128, 28],
      [140, 12],
      [156, 8],
      [172, 18],
      [184, 40],
      [190, 62],
    ],
    strokeWidth: 4,
    z: 4,
  },
  {
    id: "mock-5",
    type: "arrow",
    title: "Arrow",
    color: "gray",
    x: 226,
    y: 152,
    width: 84,
    height: 84,
    points: [
      [0, 0],
      [84, 84],
    ],
    strokeWidth: 2,
    z: 5,
  },
]

let nextId = 100

/**
 * In-memory implementation of the whiteboard store. Used when the app is not
 * hosted inside Notion (dev harness / standalone preview).
 */
export function useMockStore(): WhiteboardStore {
  const params = new URLSearchParams(window.location.search)
  const empty = params.has("empty")
  // Dev harness: preview the loading skeleton with ?loading=1.
  const forceLoading = params.has("loading")
  const [items, setItems] = useState<BoardItem[]>(empty ? [] : SEED)
  const [saveState, setSaveState] = useState<SaveState>("idle")
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const touch = useCallback(() => {
    clearTimeout(saveTimer.current)
    clearTimeout(idleTimer.current)
    setSaveState("saving")
    saveTimer.current = setTimeout(() => {
      setSaveState("saved")
      idleTimer.current = setTimeout(() => setSaveState("idle"), 1400)
    }, 500)
  }, [])

  const createItem = useCallback(
    (item: Omit<BoardItem, "id">): string => {
      const id = `mock-${nextId++}`
      setItems((prev) => [...prev, { ...item, id }])
      touch()
      return id
    },
    [touch]
  )

  const updateItem = useCallback(
    (id: string, patch: Partial<Omit<BoardItem, "id">>) => {
      setItems((prev) =>
        prev.map((it) => (it.id === id ? { ...it, ...patch } : it))
      )
      touch()
    },
    [touch]
  )

  const deleteItem = useCallback(
    (id: string) => {
      setItems((prev) => prev.filter((it) => it.id !== id))
      touch()
    },
    [touch]
  )

  return {
    items,
    isLoading: forceLoading,
    // Dev harness: preview the unbound/setup state with ?unbound=1.
    loadError: params.has("unbound")
      ? "Couldn't load the whiteboard database. Map a database to the “items” key in the block settings."
      : null,
    setupIssues: params.has("schema")
      ? [
          {
            property: "Type",
            message: "Add the missing Select options: stroke, line, arrow.",
          },
          {
            property: "Color",
            message:
              "Map this field to a Select property instead of Rich text.",
          },
        ]
      : [],
    saveState,
    createItem,
    updateItem,
    deleteItem,
  }
}
