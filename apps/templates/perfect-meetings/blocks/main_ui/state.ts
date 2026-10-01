import type { NotionDataSourcePage } from "@notionhq/apps/custom-blocks"

import { dateRange, splitEmails, text } from "./meeting"

// Pure helpers that derive what the block shows from Workflow runs and
// Meetings rows. Nothing here is stored: every state comes from existing data.

/** Workflow runs Status values (src/notion.ts RUN_STATUS). */
export const RUN = {
  pending: "Pending",
  success: "Success",
  failed: "Failed",
} as const

/** Meetings Prep status values (src/notion.ts PREP_STATUS). */
export const PREP = {
  queued: "Queued",
  researching: "Researching",
  ready: "Ready",
  failed: "Failed",
} as const

/**
 * A run row with no Status, or a Pending one, older than this is treated as
 * stuck: the Sync button comes back so the viewer can try again. A crashed or
 * timed-out ingest stays Pending, and a row the workflow never picked up has
 * no Status.
 */
export const STALE_RUN_MS = 15 * 60 * 1000

export type LatestRun = {
  status: string | null
  startedMs: number | null
  error: string
}

export type BlockState =
  | { kind: "never_run" }
  | { kind: "waiting"; stale: boolean }
  | { kind: "syncing"; stale: boolean }
  | { kind: "researching"; done: number; total: number }
  | { kind: "failed"; error: string }
  | { kind: "ready"; noMeetings: boolean }

export type BlockStateInput = {
  /** The newest Workflow runs row by Started, or null when there is none. */
  latestRun: LatestRun | null
  /** Whether any Workflow runs row has Status Success. */
  hasSuccessRun: boolean
  /** Whether any meeting has Prep updated set (written only on Ready). */
  hasPrepUpdated: boolean
  /** How many meetings that are not cancelled the block found. */
  meetingCount: number
  /** Research progress for the latest sync (see researchProgress). */
  progress: { done: number; total: number }
  now: number
}

/**
 * Whether the App has ever shown real data: some meeting has a finished
 * brief, or a successful sync found no outside meetings at all. Once this is
 * true the block always shows the calendar UI.
 */
export function isPopulated(input: BlockStateInput): boolean {
  return (
    input.hasPrepUpdated || (input.hasSuccessRun && input.meetingCount === 0)
  )
}

export function blockState(input: BlockStateInput): BlockState {
  if (isPopulated(input))
    return { kind: "ready", noMeetings: input.meetingCount === 0 }
  const run = input.latestRun
  if (!run) return { kind: "never_run" }
  const stale =
    run.startedMs !== null && input.now - run.startedMs > STALE_RUN_MS
  switch (run.status) {
    case null:
    case "":
      return { kind: "waiting", stale }
    case RUN.pending:
      return { kind: "syncing", stale }
    case RUN.failed:
      return {
        kind: "failed",
        error: run.error.trim() || "The sync failed without an error message.",
      }
    default:
      if (input.progress.done < input.progress.total)
        return { kind: "researching", ...input.progress }
      return { kind: "ready", noMeetings: input.meetingCount === 0 }
  }
}

/** Whether the Sync calendar button can be pressed in a state. */
export function canSync(state: BlockState): boolean {
  switch (state.kind) {
    case "never_run":
    case "failed":
      return true
    case "waiting":
    case "syncing":
      return state.stale
    default:
      return false
  }
}

/** The status line shown next to the Sync button. */
export function statusText(state: BlockState): string {
  switch (state.kind) {
    case "never_run":
      return "Sync your calendar to find meetings with outside attendees."
    case "waiting":
      return state.stale
        ? "Still waiting for the flow to start. Open the Sync calendar workflow in Notion and save it, then try again."
        : "Waiting for flow to start"
    case "syncing":
      return state.stale
        ? "The last sync did not finish. Try again."
        : "Reading latest calendar events"
    case "researching":
      return `Researching companies and people (${state.done} of ${state.total} meetings ready)`
    case "failed":
      return "The last sync failed."
    case "ready":
      return ""
  }
}

function hasEnded(row: NotionDataSourcePage, now: number): boolean {
  const range = dateRange(row.propertiesByKey.When)
  return range !== null && range.endMs <= now
}

/** Whether research is running, or still due to run, for a meeting. */
export function researchPending(
  row: NotionDataSourcePage,
  now: number
): boolean {
  const status = text(row.propertiesByKey["Prep status"])
  if (status === PREP.researching) return true
  // Prep skips meetings that have already ended, so those stay Queued.
  return status === PREP.queued && !hasEnded(row, now)
}

/**
 * Research progress for the latest sync, as k of n meetings.
 *
 * n counts the meetings research will cover: not cancelled, with outside
 * attendees, and either not yet ended or being researched now. Past meetings
 * are left out because prep skips them. k counts those whose Prep status is
 * Ready or Failed: a failed meeting is finished, so it does not stall the
 * count. Rows are deduplicated by ID, so overlapping queries can be merged.
 */
export function researchProgress(
  rows: readonly NotionDataSourcePage[],
  now: number
): { done: number; total: number } {
  let done = 0
  let total = 0
  const unique = new Map(rows.map((row) => [row.id, row]))
  for (const row of unique.values()) {
    if (text(row.propertiesByKey.Status) === "Cancelled") continue
    if (splitEmails(text(row.propertiesByKey["Attendee emails"])).length === 0)
      continue
    const status = text(row.propertiesByKey["Prep status"])
    if (researchPending(row, now)) {
      total++
    } else if (
      (status === PREP.ready || status === PREP.failed) &&
      !hasEnded(row, now)
    ) {
      total++
      done++
    }
  }
  return { done, total }
}

export type AttendeeCopy =
  | { kind: "loading" }
  | { kind: "message"; text: string }
  | { kind: "cards"; note: string | null }

const FAILED_COPY =
  "Research failed for this meeting. Tick Regenerate prep on the meeting to try again."

/**
 * What a meeting's attendee section shows. "Still loading" is used only while
 * research is running, or about to run, for that meeting.
 */
export function attendeeCopy(
  row: NotionDataSourcePage,
  foundAttendees: number,
  peopleLoading: boolean,
  now: number
): AttendeeCopy {
  const emails = splitEmails(text(row.propertiesByKey["Attendee emails"]))
  if (emails.length === 0)
    return { kind: "message", text: "No outside attendees on this meeting." }
  const failed = text(row.propertiesByKey["Prep status"]) === PREP.failed
  if (foundAttendees > 0)
    return { kind: "cards", note: failed ? FAILED_COPY : null }
  if (peopleLoading) return { kind: "loading" }
  if (failed) return { kind: "message", text: FAILED_COPY }
  if (researchPending(row, now))
    return { kind: "message", text: "Attendee details are still loading." }
  return {
    kind: "message",
    text: "No attendee details for this meeting. Tick Regenerate prep on the meeting to research them.",
  }
}
