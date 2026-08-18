/**
 * Two-sync pattern — backfill + delta writing to the same database.
 *
 * Instead of a single sync with a bi-modal state machine (phase: "backfill" | "delta"),
 * this uses two separate syncs targeting the same database:
 *
 * - **Backfill sync** (replace mode, manual schedule): Paginates the full dataset
 *   using keyset pagination on (created_at, id). Triggered on demand via CLI.
 * - **Delta sync** (incremental mode, 5m schedule): Fetches only recently modified
 *   records using keyset pagination on (updated_at, id) with a 15s consistency buffer.
 *
 * Advantages over the single-sync bi-modal approach:
 * - No phase discrimination in state — each sync has simple, focused state
 * - No backfill-to-delta transition logic
 * - Backfill and delta run independently — re-backfill anytime without disrupting delta
 * - Easier to reason about and debug
 *
 * This is the Salesforce/HubSpot pattern:
 * - Backfill: keyset pagination on (created_at, id)
 * - Delta: keyset pagination on (updated_at, id) with consistency buffer
 *
 * To trigger a full re-backfill:
 *   ntn workers sync state reset contactsBackfill && ntn workers sync trigger contactsBackfill
 */

import { Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

const worker = new Worker()
export default worker

// One database shared by both syncs
const contacts = worker.database("contacts", {
  type: "managed",
  initialTitle: "Contacts",
  primaryKeyProperty: "Contact ID",
  schema: {
    properties: {
      Name: Schema.title(),
      "Contact ID": Schema.richText(),
    },
  },
})

// One pacer shared by both syncs — budget is apportioned evenly
const apiPacer = worker.pacer("crm", {
  allowedRequests: 10,
  intervalMs: 1000,
})

const BATCH_SIZE = 100
const CONSISTENCY_BUFFER_MS = 15_000 // 15 seconds

// ---------------------------------------------------------------------------
// Shared helper — maps a contact record to a sync upsert change
// ---------------------------------------------------------------------------
function toUpsert(record: { id: string; name: string }) {
  return {
    type: "upsert" as const,
    key: record.id,
    properties: {
      Name: Builder.title(record.name),
      "Contact ID": Builder.richText(record.id),
    },
  }
}

// ---------------------------------------------------------------------------
// Backfill sync: replace mode, manual schedule
// ---------------------------------------------------------------------------
// Paginates the full dataset using keyset pagination on (created_at, id).
// Replace mode means the runtime will delete any records not seen during the
// full cycle, ensuring the database is a faithful mirror of the source.

type BackfillState = {
  cursorTimestamp: string | null
  cursorId: string | null
}

worker.sync("contactsBackfill", {
  database: contacts,
  mode: "replace",
  schedule: "manual",
  execute: async (state: BackfillState | undefined) => {
    // Keyset pagination: WHERE created_at > X OR (created_at = X AND id > Y)
    const params = new URLSearchParams({
      limit: String(BATCH_SIZE),
      order_by: "created_at,id",
    })
    if (state?.cursorTimestamp) {
      params.set("created_after", state.cursorTimestamp)
      params.set("created_after_id", state.cursorId ?? "")
    }

    await apiPacer.wait()
    const response = await fetch(`https://api.example.com/contacts?${params}`, {
      headers: { Authorization: `Bearer ${process.env.API_TOKEN}` },
    })
    const data = await response.json()
    const records: Array<{
      id: string
      name: string
      created_at: string
    }> = data.contacts
    const done = records.length < BATCH_SIZE

    if (done) {
      return {
        changes: records.map(toUpsert),
        hasMore: false,
      }
    }

    const last = records[records.length - 1]
    return {
      changes: records.map(toUpsert),
      hasMore: true,
      nextState: {
        cursorTimestamp: last.created_at,
        cursorId: last.id,
      },
    }
  },
})

// ---------------------------------------------------------------------------
// Delta sync: incremental mode, every 5 minutes
// ---------------------------------------------------------------------------
// Fetches only records modified since the cursor. Uses keyset pagination on
// (updated_at, id) with a 15s consistency buffer to avoid advancing past
// records that the API hasn't indexed yet.

type DeltaState = {
  cursorTimestamp: string
  cursorId: string
}

worker.sync("contactsDelta", {
  database: contacts,
  mode: "incremental",
  schedule: "5m",
  execute: async (state: DeltaState | undefined) => {
    // On first run, start from "now" minus the consistency buffer.
    // This means the first delta cycle won't fetch any historical data —
    // that's the backfill sync's job.
    if (!state) {
      const startTs = new Date(Date.now() - CONSISTENCY_BUFFER_MS).toISOString()
      return {
        changes: [],
        hasMore: false,
        nextState: { cursorTimestamp: startTs, cursorId: "" },
      }
    }

    const params = new URLSearchParams({
      limit: String(BATCH_SIZE),
      order_by: "updated_at,id",
      updated_after: state.cursorTimestamp,
      updated_after_id: state.cursorId,
    })

    await apiPacer.wait()
    const response = await fetch(`https://api.example.com/contacts?${params}`, {
      headers: { Authorization: `Bearer ${process.env.API_TOKEN}` },
    })
    const data = await response.json()
    const records: Array<{
      id: string
      name: string
      updated_at: string
    }> = data.contacts
    const done = records.length < BATCH_SIZE

    // Consistency buffer: never advance the cursor closer than 15s to "now".
    // In incremental mode the cursor never resets, so if we advance past a record
    // that hasn't been indexed yet, it's lost permanently.
    const bufferTs = new Date(Date.now() - CONSISTENCY_BUFFER_MS).toISOString()
    const last = records[records.length - 1]

    let nextCursorTs: string
    let nextCursorId: string
    if (done) {
      // Caught up — cap the cursor at the buffer boundary
      nextCursorTs =
        last && last.updated_at < bufferTs
          ? last.updated_at
          : state.cursorTimestamp < bufferTs
            ? bufferTs
            : state.cursorTimestamp
      nextCursorId = last?.id ?? state.cursorId
    } else {
      // More pages — advance cursor to last record on this page
      nextCursorTs = last.updated_at
      nextCursorId = last.id
    }

    return {
      changes: records.map(toUpsert),
      hasMore: !done,
      nextState: {
        cursorTimestamp: nextCursorTs,
        cursorId: nextCursorId,
      },
    }
  },
})
