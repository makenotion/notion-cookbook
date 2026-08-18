/**
 * Delta sync — event-feed pattern (Stripe-style).
 *
 * This is the delta half of a backfill+delta pair. It reads from an events/
 * changelog endpoint to detect changes incrementally. A separate replace-mode
 * backfill sync (not shown here) handles the full dataset load.
 *
 * The event feed provides a reliable change stream: each event has a unique ID
 * that serves as a cursor. Events can produce both upserts and deletes.
 *
 * Key points:
 * - State is just { eventCursor: string } — no phase discrimination
 * - First run: fetch the latest event ID as the starting cursor
 * - Consistency buffer: skip events younger than 10 seconds (they may not be
 *   fully consistent yet, and since the cursor never resets, skipping = permanent loss)
 * - Events can map to both upserts and deletes
 *
 * For the backfill half, use a replace-mode sync targeting the same database —
 * see replace-paginated.ts for the pattern. Trigger it via CLI:
 *   ntn workers sync state reset customersBackfill && ntn workers sync trigger customersBackfill
 */

import { Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

const worker = new Worker()
export default worker

// Database shared between backfill (replace) and this delta (incremental) sync
const customers = worker.database("customers", {
  type: "managed",
  initialTitle: "Customers",
  primaryKeyProperty: "Customer ID",
  schema: {
    properties: {
      Name: Schema.title(),
      "Customer ID": Schema.richText(),
    },
  },
})

// Rate-limit API calls — shared across all syncs hitting this API
const apiPacer = worker.pacer("stripe", {
  allowedRequests: 25,
  intervalMs: 1000,
})

const CONSISTENCY_BUFFER_SECONDS = 10

type DeltaState = { eventCursor: string }

// Delta sync: reads the event feed for incremental changes
worker.sync("customersDelta", {
  database: customers,
  mode: "incremental",
  schedule: "5m",
  execute: async (state: DeltaState | undefined) => {
    // First run: capture the latest event ID as the starting cursor.
    // We don't process any events on the first run — the backfill sync
    // handles the full dataset. This just establishes "start here" for
    // future delta cycles.
    if (!state) {
      await apiPacer.wait()
      const anchorResponse = await apiCall("/v1/events?limit=1")
      const eventCursor = anchorResponse.data[0]?.id ?? ""
      return {
        changes: [],
        hasMore: false,
        nextState: { eventCursor },
      }
    }

    // Read events from the changelog endpoint.
    // Events are returned in reverse-chronological order, so we read backwards
    // from the latest event to our cursor position.
    await apiPacer.wait()
    const response = await apiCall(
      `/v1/events?limit=100&ending_before=${state.eventCursor}`
    )
    const events: Array<{
      id: string
      type: string
      created: number
      data: { object: { id: string; name: string } }
    }> = response.data

    // Consistency buffer: skip events younger than 10 seconds.
    // The event stream may not be fully consistent for very recent events.
    // Since the cursor never resets, advancing past an inconsistent event
    // means we'd miss the final state of that record permanently.
    const cutoff = Date.now() / 1000 - CONSISTENCY_BUFFER_SECONDS
    const safeEvents = events.filter((e) => e.created < cutoff)

    // Map events to changes (upserts or deletes)
    const changes = safeEvents.map((event) => {
      if (event.type.endsWith(".deleted")) {
        return { type: "delete" as const, key: event.data.object.id }
      }
      return toUpsert(event.data.object)
    })

    // Only advance cursor if we have safe events to process.
    // If all events are too recent, cursor stays put — we'll re-check next cycle.
    const lastSafe = safeEvents[safeEvents.length - 1]
    const nextCursor = lastSafe?.id ?? state.eventCursor

    return {
      changes,
      hasMore: response.has_more && safeEvents.length > 0,
      nextState: { eventCursor: nextCursor },
    }
  },
})

function toUpsert(customer: { id: string; name: string }) {
  return {
    type: "upsert" as const,
    key: customer.id,
    properties: {
      Name: Builder.title(customer.name),
      "Customer ID": Builder.richText(customer.id),
    },
  }
}

async function apiCall(path: string) {
  const response = await fetch(`https://api.stripe.com${path}`, {
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
  })
  return response.json()
}
