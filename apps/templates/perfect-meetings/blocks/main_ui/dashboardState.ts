import type { QueryState } from "./live"
import { RUN, STALE_RUN_MS, type LatestRun } from "./state"

export type CalendarStatus = {
  kind:
    | "loading"
    | "unavailable"
    | "idle"
    | "waiting"
    | "syncing"
    | "success"
    | "failed"
    | "stale"
  label: string
  detail?: string
  busy: boolean
}

function elapsedLabel(time: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - time) / 60_000))
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Calendar activity comes only from the calendar run, independently of research. */
export function calendarStatus(
  latestRun: LatestRun | null,
  requestPending: boolean,
  query: Pick<QueryState<unknown>, "hasData" | "error">,
  now: number
): CalendarStatus {
  if (requestPending)
    return { kind: "waiting", label: "Waiting for sync to start", busy: true }
  if (query.error)
    return {
      kind: "unavailable",
      label: "Sync status unavailable",
      busy: false,
    }
  if (!query.hasData)
    return { kind: "loading", label: "Checking sync status…", busy: false }
  if (!latestRun)
    return { kind: "idle", label: "Ready to sync your calendar", busy: false }
  if (latestRun.status === RUN.failed)
    return {
      kind: "failed",
      label: "Calendar sync failed",
      busy: false,
      detail: latestRun.error.trim() || "Try syncing again.",
    }
  if (latestRun.status === RUN.success)
    return {
      kind: "success",
      busy: false,
      label:
        latestRun.finishedMs == null
          ? "Calendar synced"
          : `Synced ${elapsedLabel(latestRun.finishedMs, now)}`,
    }
  if (!latestRun.status || latestRun.status === RUN.pending) {
    if (
      latestRun.startedMs !== null &&
      now - latestRun.startedMs > STALE_RUN_MS
    )
      return {
        kind: "stale",
        label: "Calendar sync needs attention",
        busy: false,
        detail: "The last sync hasn't finished. Try again.",
      }
    return latestRun.status === RUN.pending
      ? { kind: "syncing", label: "Syncing your calendar…", busy: true }
      : { kind: "waiting", label: "Waiting for sync to start", busy: true }
  }
  return { kind: "unavailable", label: "Sync status unavailable", busy: false }
}
