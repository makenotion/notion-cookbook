import type {
  DataSourceQueryOptions,
  NotionDataSourcePage,
} from "@notionhq/apps/custom-blocks"

import { dayBounds, sortByStart, text } from "./meeting"
import { PREP, RUN, runStartedMs, type LatestRun } from "./state"

// The block reads four live queries: one each for Meetings, Workflow runs,
// People, and Companies. Everything else is derived here, in memory.
//
// Why so few: the SDK re-sends every subscription's query whenever the host
// reports a change to that data source (subscribeToDataSource compares the
// data source's signature and force-requeries on a change), and it offers
// no debounce. During research the workflows write many Meetings, People,
// and Companies rows, so each extra subscription multiplies the requests.

const DAY_MS = 24 * 60 * 60 * 1000

/** Meetings from this many days back are read, for multi-day events. */
export const MEETINGS_LOOKBACK_DAYS = 3
export const MEETINGS_LIMIT = 200
/** Recent runs are enough for the latest run and the success count. */
export const RUNS_LIMIT = 10

/**
 * Start of the meetings window: local midnight MEETINGS_LOOKBACK_DAYS ago.
 * It changes once a day, so the query options stay identical between
 * renders and the subscription is not replaced.
 */
export function meetingsWindowStart(now: number): string {
  return new Date(
    dayBounds(now - MEETINGS_LOOKBACK_DAYS * DAY_MS).startMs
  ).toISOString()
}

/** The one Meetings query. Same input, same JSON, so no resubscribe. */
export function meetingsQuery(windowStart: string): DataSourceQueryOptions {
  return {
    limit: MEETINGS_LIMIT,
    filter: {
      and: [
        { key: "When", date: { on_or_after: windowStart } },
        { key: "Status", select: { does_not_equal: "Cancelled" } },
      ],
    },
    sorts: [{ key: "When", direction: "ascending" }],
  }
}

export const RUNS_QUERY: DataSourceQueryOptions = {
  limit: RUNS_LIMIT,
  sorts: [{ key: "Started", direction: "descending" }],
}

export const PEOPLE_QUERY: DataSourceQueryOptions = { limit: 999 }
export const COMPANIES_QUERY: DataSourceQueryOptions = { limit: 999 }

/** The latest run and how many recent runs succeeded (at most 2 counted). */
export function deriveRuns(rows: readonly NotionDataSourcePage[]): {
  latestRun: LatestRun | null
  successRuns: number
} {
  const latest = rows[0]
  const successes = rows.filter(
    (row) => text(row.propertiesByKey.Status) === RUN.success
  ).length
  return {
    latestRun: latest
      ? {
          id: latest.id,
          status: text(latest.propertiesByKey.Status) || null,
          startedMs: runStartedMs(latest),
          error: text(latest.propertiesByKey.Error),
        }
      : null,
    successRuns: Math.min(successes, 2),
  }
}

/** Sorted meetings and the populated signals, from the one Meetings query. */
export function deriveMeetings(rows: readonly NotionDataSourcePage[]): {
  meetings: NotionDataSourcePage[]
  hasPrepUpdated: boolean
  hasPrepFinished: boolean
} {
  const meetings = sortByStart(rows)
  return {
    meetings,
    hasPrepUpdated: meetings.some((row) => {
      const value = row.propertiesByKey["Prep updated"]
      return typeof value === "object" && value !== null
    }),
    hasPrepFinished: meetings.some((row) => {
      const status = text(row.propertiesByKey["Prep status"])
      return status === PREP.ready || status === PREP.failed
    }),
  }
}
