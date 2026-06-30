// Shared Salesforce sync lifecycle. Fast incremental syncs query records in a
// fixed SystemModstamp window; daily replacement syncs reconcile deletions and
// any records missed while the worker was offline.

import type { SalesforceClient } from "./salesforce.js"

const INITIAL_SYNC_START = "1970-01-01T00:00:00.000Z"
const CURSOR_OVERLAP_MS = 2 * 60 * 1_000

export type SalesforceRecord = {
  Id: string
  IsDeleted: boolean
  SystemModstamp: string
}

type SalesforceUpsert = {
  type: "upsert"
  key: string
  upstreamUpdatedAt: string
  properties: any
  pageContentMarkdown?: string
}

export type SalesforceResource<T extends SalesforceRecord> = {
  objectName: "Account" | "Opportunity"
  fields: readonly string[]
  toChange(record: T, instanceUrl: string): SalesforceUpsert
}

export type IncrementalSyncState = {
  since: string
  until?: string
  nextCursor?: string
}

export type ReconciliationSyncState = {
  nextCursor: string
}

function isoDateTime(value: string, label: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be an ISO 8601 timestamp.`)
  }
  return date.toISOString()
}

export function toSoqlDateTime(value: string): string {
  return isoDateTime(value, "Salesforce sync timestamp").replace(
    /\.\d{3}Z$/,
    "Z"
  )
}

function checkpointWithOverlap(until: string): string {
  const untilMs = new Date(until).getTime()
  const initialMs = new Date(INITIAL_SYNC_START).getTime()
  return new Date(Math.max(initialMs, untilMs - CURSOR_OVERLAP_MS)).toISOString()
}

export function incrementalSoql<T extends SalesforceRecord>(
  resource: SalesforceResource<T>,
  since: string,
  until: string
): string {
  return [
    `SELECT ${resource.fields.join(", ")}`,
    `FROM ${resource.objectName}`,
    `WHERE SystemModstamp > ${toSoqlDateTime(since)}`,
    `AND SystemModstamp <= ${toSoqlDateTime(until)}`,
    "ORDER BY SystemModstamp ASC, Id ASC",
  ].join(" ")
}

export function reconciliationSoql<T extends SalesforceRecord>(
  resource: SalesforceResource<T>
): string {
  return `SELECT ${resource.fields.join(", ")} FROM ${resource.objectName} ORDER BY Id ASC`
}

export async function runIncrementalPage<T extends SalesforceRecord>(
  client: SalesforceClient,
  resource: SalesforceResource<T>,
  state: IncrementalSyncState | undefined,
  now: () => Date = () => new Date()
) {
  const since = isoDateTime(
    state?.since ?? INITIAL_SYNC_START,
    "Salesforce sync state.since"
  )
  if (state?.nextCursor && !state.until) {
    throw new Error("Salesforce paginated sync state is missing until.")
  }

  // Keep the upper bound fixed while following Salesforce's query locator so
  // a record changing mid-cycle is picked up by the next overlapping window.
  const until = state?.nextCursor
    ? isoDateTime(state.until!, "Salesforce sync state.until")
    : now().toISOString()
  const query = incrementalSoql(resource, since, until)
  const page = await client.queryPage<T>(query, state?.nextCursor, true)
  const changes = page.records.map((record) =>
    record.IsDeleted
      ? { type: "delete" as const, key: record.Id }
      : resource.toChange(record, client.instanceUrl)
  )

  if (page.nextCursor) {
    return {
      changes,
      hasMore: true,
      nextState: { since, until, nextCursor: page.nextCursor },
    }
  }

  return {
    changes,
    hasMore: false,
    // Incremental mode persists this checkpoint between scheduled runs. The
    // overlap makes retries safe and covers indexing/clock skew at the edge.
    nextState: { since: checkpointWithOverlap(until) },
  }
}

export async function runReconciliationPage<T extends SalesforceRecord>(
  client: SalesforceClient,
  resource: SalesforceResource<T>,
  state: ReconciliationSyncState | undefined
) {
  const page = await client.queryPage<T>(
    reconciliationSoql(resource),
    state?.nextCursor
  )
  const changes = page.records.map((record) =>
    resource.toChange(record, client.instanceUrl)
  )

  if (page.nextCursor) {
    return {
      changes,
      hasMore: true,
      nextState: { nextCursor: page.nextCursor },
    }
  }

  return { changes, hasMore: false }
}
