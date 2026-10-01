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
 * A run row with no Status or a Pending one, or a meeting Queued or
 * Researching, that has not changed for this long is treated as stuck. A
 * crashed or timed-out ingest stays Pending, a row the workflow never picked
 * up has no Status, and a prep polls research for at most 10 minutes.
 */
export const STALE_RUN_MS = 20 * 60 * 1000

export type LatestRun = {
  id: string
  status: string | null
  /** Started, or the row's created time when Started is empty. */
  startedMs: number | null
  error: string
}

export type Progress = {
  /** Meetings whose research finished, Ready or Failed. */
  done: number
  /** Meetings research covers that are not stuck. */
  total: number
  /** Meetings Queued or Researching that look stuck. */
  stalled: number
}

export type BlockState =
  | { kind: "never_run" }
  | { kind: "waiting"; stale: boolean }
  | { kind: "syncing"; stale: boolean }
  | { kind: "researching"; done: number; total: number; stalled: number }
  | { kind: "failed"; error: string }
  | { kind: "ready"; noMeetings: boolean }

export type BlockStateInput = {
  /** The newest Workflow runs row by Started, or null when there is none. */
  latestRun: LatestRun | null
  /** How many Success runs exist, counting at most 2. */
  successRuns: number
  /** Whether any meeting has Prep updated set (written only on Ready). */
  hasPrepUpdated: boolean
  /** Whether any meeting has Prep status Ready or Failed. */
  hasPrepFinished: boolean
  /** How many meetings that are not cancelled the block found. */
  meetingCount: number
  /** Research progress for the latest sync (see researchProgress). */
  progress: Progress
  now: number
}

/**
 * Whether the App has shown real data: a meeting's research finished (Ready
 * or Failed, or Prep updated set), a successful sync found no outside
 * meetings at all, or a second sync has succeeded since setup. Every signal
 * only grows over time, and the block also latches the result for the
 * session (latchPopulated), so ready never falls back to a setup state.
 */
export function isPopulated(input: BlockStateInput): boolean {
  return (
    input.hasPrepUpdated ||
    input.hasPrepFinished ||
    (input.successRuns > 0 && input.meetingCount === 0) ||
    input.successRuns >= 2
  )
}

/** Once populated in a session, always populated. */
export function latchPopulated(
  previous: boolean,
  input: BlockStateInput | null
): boolean {
  return previous || (input !== null && isPopulated(input))
}

export function blockState(
  input: BlockStateInput,
  populated = isPopulated(input)
): BlockState {
  if (populated || isPopulated(input))
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
    case "researching":
      return state.stalled > 0
    default:
      return false
  }
}

/** The status line shown next to the Sync button. */
export function statusText(state: BlockState): string {
  switch (state.kind) {
    case "never_run":
      return ""
    case "waiting":
      return state.stale
        ? "Still waiting for the flow to start. Open the Sync calendar workflow in Notion and save it, then try again."
        : "Waiting for flow to start"
    case "syncing":
      return state.stale
        ? "The last sync did not finish. Try again."
        : "Reading latest calendar events"
    case "researching": {
      const line = `Researching companies and people (${state.done} of ${state.total} meetings ready)`
      return state.stalled > 0
        ? `${line}. ${state.stalled} meeting(s) look stuck: sync again, or tick Regenerate prep on them.`
        : line
    }
    case "failed":
      return "The last sync failed."
    case "ready":
      return ""
  }
}

/** Epoch ms of a date-shaped value, or null. */
export function dateMs(value: unknown): number | null {
  return dateRange(value)?.startMs ?? null
}

/** A run row's start: Started, or its created time when Started is empty. */
export function runStartedMs(row: NotionDataSourcePage): number | null {
  return (
    dateMs(row.propertiesByKey.Started) ??
    dateMs(row.propertiesById.created_time)
  )
}

/** When a meeting last changed: Prep updated or its last edit, if later. */
export function lastActivityMs(row: NotionDataSourcePage): number | null {
  const times = [
    dateMs(row.propertiesByKey["Prep updated"]),
    dateMs(row.propertiesById.last_edited_time),
  ].filter((ms): ms is number => ms !== null)
  return times.length > 0 ? Math.max(...times) : null
}

function hasEnded(row: NotionDataSourcePage, now: number): boolean {
  const range = dateRange(row.propertiesByKey.When)
  return range !== null && range.endMs <= now
}

/** Whether a meeting is Queued or Researching and that research is still due. */
function waitingOnResearch(row: NotionDataSourcePage, now: number): boolean {
  const status = text(row.propertiesByKey["Prep status"])
  if (status === PREP.researching) return true
  // Prep skips meetings that have already ended, so those stay Queued.
  return status === PREP.queued && !hasEnded(row, now)
}

/** Whether a waiting meeting has not changed for STALE_RUN_MS. */
export function researchStuck(row: NotionDataSourcePage, now: number): boolean {
  if (!waitingOnResearch(row, now)) return false
  const last = lastActivityMs(row)
  return last !== null && now - last > STALE_RUN_MS
}

/** Whether research is running, or about to run, for a meeting. */
export function researchPending(
  row: NotionDataSourcePage,
  now: number
): boolean {
  return waitingOnResearch(row, now) && !researchStuck(row, now)
}

/**
 * Research progress for the latest sync, as k of n meetings, from one query.
 *
 * n counts the meetings research covers: not cancelled, with outside
 * attendees, and either not yet ended or being researched now. Past meetings
 * are left out because prep skips them, and stuck meetings are counted
 * separately as stalled. k counts those whose Prep status is Ready or
 * Failed: a failed meeting is finished, so it does not stall the count. Rows
 * are deduplicated by ID.
 */
export function researchProgress(
  rows: readonly NotionDataSourcePage[],
  now: number
): Progress {
  let done = 0
  let total = 0
  let stalled = 0
  const unique = new Map(rows.map((row) => [row.id, row]))
  for (const row of unique.values()) {
    if (text(row.propertiesByKey.Status) === "Cancelled") continue
    if (splitEmails(text(row.propertiesByKey["Attendee emails"])).length === 0)
      continue
    const status = text(row.propertiesByKey["Prep status"])
    if (researchStuck(row, now)) {
      stalled++
    } else if (researchPending(row, now)) {
      total++
    } else if (
      (status === PREP.ready || status === PREP.failed) &&
      !hasEnded(row, now)
    ) {
      total++
      done++
    }
  }
  return { done, total, stalled }
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
  if (researchStuck(row, now))
    return {
      kind: "message",
      text: "Research looks stuck for this meeting. Tick Regenerate prep on the meeting to try again.",
    }
  if (researchPending(row, now))
    return { kind: "message", text: "Attendee details are still loading." }
  return {
    kind: "message",
    text: "No attendee details for this meeting. Tick Regenerate prep on the meeting to research them.",
  }
}
