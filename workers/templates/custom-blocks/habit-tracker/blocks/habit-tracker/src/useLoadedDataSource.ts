import { useEffect, useRef, useState } from "react"
import type { CustomBlockErrorInfo } from "@notionhq/custom-blocks"
import type { DataSourceQuerySnapshot } from "@notionhq/custom-blocks/data-sources"
import type { NotionPage, NotionPageData } from "@notionhq/custom-blocks/pages"
import { useDataSource } from "@notionhq/custom-blocks/react"

export type LoadedPageReference = {
  reference: NotionPage
  data: NotionPageData
}

type LoadedSnapshot = Omit<DataSourceQuerySnapshot, "items"> & {
  items: LoadedPageReference[]
}

type LoadedState =
  | {
      snapshot: DataSourceQuerySnapshot
      status: "success"
      items: LoadedPageReference[]
    }
  | {
      snapshot: DataSourceQuerySnapshot
      status: "error"
      error: CustomBlockErrorInfo
    }

type SnapshotRead = {
  snapshot: DataSourceQuerySnapshot
  promise: Promise<LoadedPageReference[] | CustomBlockErrorInfo>
}

export type LoadedDataSourceResult =
  | { status: "loading" }
  | { status: "success"; value: LoadedSnapshot }
  | { status: "error"; error: CustomBlockErrorInfo }

/** Loads the page data carried by each query reference before exposing properties. */
export function useLoadedDataSource(
  key: string,
  options: { limit?: number } = {}
): LoadedDataSourceResult {
  const query = useDataSource(key, options)
  const snapshot = query.status === "success" ? query.value : undefined
  const [loadedState, setLoadedState] = useState<LoadedState>()
  const snapshotRead = useRef<SnapshotRead | undefined>(undefined)

  useEffect(() => {
    if (snapshot === undefined) {
      setLoadedState(undefined)
      return
    }

    let read = snapshotRead.current
    if (read?.snapshot !== snapshot) {
      read = { snapshot, promise: readSnapshot(snapshot) }
      snapshotRead.current = read
    }

    let active = true
    void read.promise.then(
      (result) => {
        if (!active) return
        if (isError(result)) {
          setLoadedState({ snapshot, status: "error", error: result })
        } else {
          setLoadedState({ snapshot, status: "success", items: result })
        }
      },
      (error) => {
        if (!active) return
        setLoadedState({
          snapshot,
          status: "error",
          error: {
            code: "unknown_error",
            message:
              error instanceof Error
                ? error.message
                : "Page reads failed unexpectedly.",
            isRetryable: false,
          },
        })
      }
    )

    return () => {
      active = false
    }
  }, [snapshot])

  if (query.status !== "success") return query
  if (
    snapshot === undefined ||
    loadedState === undefined ||
    loadedState.snapshot !== snapshot
  ) {
    return { status: "loading" }
  }
  if (loadedState.status === "error") return loadedState
  return {
    status: "success",
    value: { ...snapshot, items: loadedState.items },
  }
}

async function readSnapshot(
  snapshot: DataSourceQuerySnapshot
): Promise<LoadedPageReference[] | CustomBlockErrorInfo> {
  const results = await Promise.all(
    snapshot.items.map(async (reference) => ({
      reference,
      result: await reference.get(),
    }))
  )
  const items: LoadedPageReference[] = []
  for (const { reference, result } of results) {
    if (result.status === "error") return result.error
    items.push({ reference, data: result.page })
  }
  return items
}

function isError(
  value: LoadedPageReference[] | CustomBlockErrorInfo
): value is CustomBlockErrorInfo {
  return !Array.isArray(value)
}
