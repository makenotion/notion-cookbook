# API Pagination & Cursor Strategy Reference

Strategies drawn from production syncs with Salesforce, Stripe, HubSpot, GitHub, and ServiceNow. Intended as a reference for building Notion Workers syncs.

> **v2 SDK:** Code snippets use the v2 SDK shape. Databases are declared separately via `worker.database()` and syncs reference them by handle. For APIs with change tracking, the recommended architecture is a **backfill sync** (`mode: "replace"`, `schedule: "manual"`) paired with a **delta sync** (`mode: "incremental"`).

---

## The Universal Contract

```
execute(state) → { changes, hasMore, nextState }
```

The cursor lives in `nextState`. The runtime calls `execute` again with that state until `hasMore` is `false`, completing a **cycle**. The next cycle starts with the state from the end of the previous cycle.

**Critical:** In incremental mode, state is never reset. The cursor persists across cycles indefinitely. When a cycle ends (`hasMore: false`), the next cycle begins with the same `nextState`. This means:

- Records behind the cursor are never re-fetched (unless you explicitly move the cursor backwards)
- A consistency buffer isn't about "catching up next time" — it's about ensuring the cursor never advances past records that haven't been indexed by the source API yet
- If a record is missed because the cursor passed it, it's missed permanently

In replace mode, the runtime handles deletion detection. Each cycle must return the complete dataset. State is only used for within-cycle pagination and is effectively reset between cycles.

---

## Source 1: Salesforce

**API type:** REST + SOQL queries
**Pagination:** Keyset on `(timestamp, id)`

### Backfill

Uses `ORDER BY CreatedDate, Id LIMIT N` with a keyset `WHERE` clause:

```sql
WHERE CreatedDate > :cursorTimestamp
   OR (CreatedDate = :cursorTimestamp AND Id > :cursorId)
```

This is the gold standard for paginating mutable datasets by timestamp. The `Id` column breaks ties when multiple records share the same `CreatedDate`, preventing both skips and duplicates.

### Delta (Incremental)

Identical keyset pattern but on `SystemModstamp` (Salesforce's last-modified timestamp) instead of `CreatedDate`. The cursor is buffered to **at most 15 seconds behind "now"** to guard against Salesforce's eventual consistency. This buffer is critical because the cursor never goes backwards — any record not yet visible when the cursor passes it is lost permanently.

### Cursor Design

With separate backfill and delta syncs, each has its own simple cursor:

```ts
// Backfill cursor (within-cycle pagination for replace mode)
type SalesforceBackfillState = { cursorTimestamp: string; cursorId: string }

// Delta cursor (persists across cycles in incremental mode)
type SalesforceDeltaState = { cursorTimestamp: string; cursorId: string }
```

Since the backfill is a replace-mode sync, its state is only used for within-cycle pagination. The delta sync's cursor persists across cycles and tracks the last-seen `SystemModstamp`.

### Gotcha: Unreliable `done` Flag

Salesforce returns a `done` boolean in query results. It lies. The production code requires _both_ `done == true` AND `records.length < limit` before treating a page as the last one. Neither signal alone is trustworthy.

### Workers Mapping

With the v2 SDK, this is modeled as two syncs: a manual backfill (replace) and a scheduled delta (incremental).

```ts
const db = worker.database("salesforce_accounts")

// Backfill: keyset pagination on CreatedDate — run manually to seed data
worker.sync("salesforceBackfill", {
  database: db,
  mode: "replace",
  schedule: "manual",
  execute: async (
    state: { cursorTimestamp: string; cursorId: string } | undefined
  ) => {
    // Keyset query: WHERE CreatedDate > X OR (CreatedDate = X AND Id > Y)
    // ORDER BY CreatedDate, Id LIMIT 100
    const records = await querySOQL(state?.cursorTimestamp, state?.cursorId)
    const last = records[records.length - 1]
    const done = records.length < 100

    return {
      changes: records.map(toUpsert),
      hasMore: !done,
      nextState: done
        ? undefined
        : { cursorTimestamp: last.CreatedDate, cursorId: last.Id },
    }
  },
})

// Delta: keyset on SystemModstamp, with 15s consistency buffer
worker.sync("salesforceDelta", {
  database: db,
  mode: "incremental",
  schedule: { cron: "*/5 * * * *" },
  execute: async (
    state: { cursorTimestamp: string; cursorId: string } | undefined
  ) => {
    const bufferTs = new Date(Date.now() - 15_000).toISOString()
    const records = await querySOQL(
      state?.cursorTimestamp,
      state?.cursorId,
      "SystemModstamp"
    )
    const last = records[records.length - 1]
    const done = records.length < 100

    return {
      changes: records.map(toUpsert),
      hasMore: !done,
      nextState: {
        cursorTimestamp: done
          ? min(last?.SystemModstamp ?? state?.cursorTimestamp, bufferTs)
          : last.SystemModstamp,
        cursorId: last?.Id ?? state?.cursorId,
      },
    }
  },
})
```

---

## Source 2: Stripe

**API type:** REST with cursor-based list pagination
**Pagination:** `starting_after` / `ending_before` + `has_more`

### Backfill

Standard Stripe list pagination: `GET /v1/customers?starting_after=cus_xyz&limit=100`. The cursor is the `id` of the last object on the page. Stripe's `has_more` boolean is reliable.

**Critical pre-step:** Before fetching any data page, the backfill captures the ID of the most recent event from `GET /v1/events?limit=1`. This "event anchor" is saved in the cursor so the delta phase knows exactly where to start.

### Delta (Event-Based)

Reads from `GET /v1/events` in reverse-chronological order. The cursor is an event ID. Events are filtered to only those at least **10 seconds old** — events younger than 10s are skipped. If all events on a page are too recent, the cursor does not advance. Since the cursor never resets, this buffer ensures the cursor doesn't permanently skip past late-arriving events.

### Nested Object Extraction

Stripe objects contain nested sub-objects (e.g., a `PaymentIntent` contains `payment_method`). The sync recursively walks payloads and extracts sub-objects. If a list field has `has_more: true`, it paginates that sub-list inline. This means one "page" of the sync may trigger many HTTP requests.

### Cursor Design

With separate syncs, each cursor is simple:

```ts
// Backfill cursor (within-cycle pagination for replace mode)
type StripeBackfillState = { cursor: string | null }

// Delta cursor (event ID, persists across cycles)
type StripeDeltaState = { cursor: string }
```

### Workers Mapping

Two syncs: a manual backfill and a scheduled delta reading from the events endpoint.

```ts
const db = worker.database("stripe_customers")

// Backfill: paginate all customers, capture event anchor for delta handoff
worker.sync("stripeBackfill", {
  database: db,
  mode: "replace",
  schedule: "manual",
  execute: async (state: { cursor: string | null } | undefined) => {
    const { data, has_more } = await stripe.customers.list({
      starting_after: state?.cursor ?? undefined,
      limit: 100,
    })
    const last = data[data.length - 1]

    return {
      changes: data.map(toUpsert),
      hasMore: has_more,
      nextState: has_more ? { cursor: last.id } : undefined,
    }
  },
})

// Delta: read events, skip any < 10s old
worker.sync("stripeDelta", {
  database: db,
  mode: "incremental",
  schedule: { cron: "*/5 * * * *" },
  execute: async (state: { cursor: string } | undefined) => {
    const { data: events, has_more } = await stripe.events.list({
      ending_before: state?.cursor,
      limit: 100,
    })
    const safeEvents = events.filter((e) => e.created < Date.now() / 1000 - 10)
    const changes = safeEvents.map(eventToChange) // map to upsert or delete
    const lastSafe = safeEvents[safeEvents.length - 1]

    return {
      changes,
      hasMore: has_more && safeEvents.length > 0,
      nextState: { cursor: lastSafe?.id ?? state?.cursor },
    }
  },
})
```

---

## Source 3: HubSpot

**API type:** REST (CRM v3 — both List and Search endpoints)
**Pagination:** Opaque `after` token (List) / timestamp cursor (Search)

### Backfill

Uses `GET /crm/v3/objects/{type}?limit=100&after=<token>`. The `after` token is opaque (HubSpot generates it). Completion is detected by the absence of the `paging` key in the response.

### Delta

Uses `POST /crm/v3/objects/{type}/search` with a `GTE` filter on `lastmodifieddate` (milliseconds). The cursor advances to `max(lastmodifieddate)` across the page. Capped to **10 seconds behind "now"** — since the cursor never resets, this ensures records still being indexed by HubSpot aren't permanently skipped.

### The Deadlock Problem

The most instructive edge case across all sources. HubSpot's Search API only sorts by one field. If >100 records share the same `lastmodifieddate`, the cursor can never advance past that timestamp — it's stuck returning the same 100 records forever.

**Detection:** If `records.length == page_limit` AND all records have the same timestamp → deadlock.

**Resolution:** Switch to a special deadlock-breaking mode that filters `lastmodifieddate EQ <stuck_timestamp>` and paginates by `hs_object_id > <last_seen_id>`. When the deadlock clears (empty page), resume normal search with cursor advanced by 1ms.

### Cursor Design

With separate syncs, the backfill cursor is simple. The delta sync still needs a multi-phase state for deadlock handling:

```ts
// Backfill cursor (within-cycle pagination for replace mode)
type HubSpotBackfillState = { afterToken: string | null }

// Delta cursor (deadlock handling requires multi-phase state)
type HubSpotDeltaState =
  | { phase: "delta"; cursorMs: number }
  | {
      phase: "deadlock"
      deadlockMs: number
      lastId: string
      resumeCursorMs: number
    }
```

### Workers Mapping

Two syncs: a manual backfill using the List endpoint, and a delta sync using the Search endpoint with deadlock handling.

```ts
const db = worker.database("hubspot_contacts")

// Backfill: paginate using opaque after token
worker.sync("hubspotBackfill", {
  database: db,
  mode: "replace",
  schedule: "manual",
  execute: async (state: { afterToken: string | null } | undefined) => {
    const { results, paging } = await hubspotList(state?.afterToken)
    const hasMore = Boolean(paging?.next?.after)

    return {
      changes: results.map(toUpsert),
      hasMore,
      nextState: hasMore ? { afterToken: paging.next.after } : undefined,
    }
  },
})

// Delta: search by lastmodifieddate with deadlock handling
type HubSpotDeltaState =
  | { phase: "delta"; cursorMs: number }
  | {
      phase: "deadlock"
      deadlockMs: number
      lastId: string
      resumeCursorMs: number
    }

worker.sync("hubspotDelta", {
  database: db,
  mode: "incremental",
  schedule: { cron: "*/5 * * * *" },
  execute: async (state: HubSpotDeltaState | undefined) => {
    if (state?.phase === "deadlock") {
      // Page through records at the stuck timestamp by ID
      const results = await hubspotSearch({
        filter: { lastmodifieddate: { eq: state.deadlockMs } },
        after: state.lastId, // hs_object_id > lastId
      })

      if (results.length === 0) {
        // Deadlock cleared — resume normal delta, advance cursor by 1ms
        return {
          changes: [],
          hasMore: true,
          nextState: { phase: "delta", cursorMs: state.resumeCursorMs + 1 },
        }
      }

      const lastId = results[results.length - 1].id
      return {
        changes: results.map(toUpsert),
        hasMore: true,
        nextState: {
          phase: "deadlock",
          deadlockMs: state.deadlockMs,
          lastId,
          resumeCursorMs: state.resumeCursorMs,
        },
      }
    }

    // Normal delta: search by lastmodifieddate >= cursorMs
    const bufferMs = Date.now() - 10_000
    const cursorMs = state?.cursorMs ?? Date.now() - 5 * 60 * 1000
    const results = await hubspotSearch({
      filter: { lastmodifieddate: { gte: cursorMs } },
      limit: 100,
    })

    // Deadlock detection
    const allSameTimestamp =
      results.length === 100 &&
      results.every((r) => r.lastmodifieddate === results[0].lastmodifieddate)

    if (allSameTimestamp) {
      return {
        changes: results.map(toUpsert),
        hasMore: true,
        nextState: {
          phase: "deadlock",
          deadlockMs: results[0].lastmodifieddate,
          lastId: results[results.length - 1].id,
          resumeCursorMs: results[0].lastmodifieddate,
        },
      }
    }

    const maxTs = Math.max(...results.map((r) => r.lastmodifieddate))
    const nextCursor = Math.min(maxTs, bufferMs)
    const done = results.length < 100

    return {
      changes: results.map(toUpsert),
      hasMore: !done,
      nextState: { phase: "delta", cursorMs: done ? nextCursor : maxTs },
    }
  },
})
```

---

## Source 4: GitHub

**API type:** GraphQL (Relay-style connections)
**Pagination:** `endCursor` + `hasNextPage` from `pageInfo`

### Backfill

Standard Relay pagination: `first: 100, after: $cursor` → `pageInfo { endCursor, hasNextPage }`. The cursor is the opaque `endCursor` string.

### Two-Level Pagination

GitHub has nested collections (e.g., issues within repositories). The sync handles this with a two-level cursor:

1. **Outer level:** paginate over repositories using `endCursor`
2. **Inner level:** for each repository, track a separate `endCursor` in a `nestedCursors` map

When inner cursors exist, the next request only queries repos with more data. The overall `hasMore` is `outerHasMore || nestedCursors.size > 0`.

### Rate Limit Awareness

The GraphQL response includes `rateLimit { limit }`. This is stored in the cursor and used to configure request pacing on subsequent pages.

### Cursor Design

```ts
type GitHubState = {
  cursor: string | null
  nestedCursors?: Record<string, string> // repo → inner endCursor
}

// hasMore = Boolean(pageInfo.hasNextPage) || Object.keys(nestedCursors ?? {}).length > 0
```

### Workers Mapping

```ts
const db = worker.database("github_repos")

worker.sync("githubSync", {
  database: db,
  mode: "replace",
  schedule: { cron: "0 * * * *" }, // GitHub GraphQL has no good incremental signal without webhooks
  execute: async (state: GitHubState | undefined) => {
    // For flat collections (e.g., repos): simple Relay pagination
    const { data, pageInfo } = await graphql(query, { after: state?.cursor })

    return {
      changes: data.map(toUpsert),
      hasMore: pageInfo.hasNextPage,
      nextState: pageInfo.hasNextPage
        ? { cursor: pageInfo.endCursor }
        : undefined,
    }

    // For nested collections (e.g., issues across repos):
    // Track nestedCursors map, query only repos with hasNextPage,
    // hasMore = outerMore || Object.keys(nestedCursors).length > 0
  },
})
```

---

## Source 5: ServiceNow

**API type:** REST (Table API with SYSPARM query language)
**Pagination:** Keyset on `(sys_updated_on, sys_id)`

### Backfill & Delta

Same keyset pattern as Salesforce, using ServiceNow's query syntax:

```
sys_updated_on>{cursor}^NQsys_updated_on={cursor}^sys_id>{sys_id}
^ORDERBYsys_updated_on^ORDERBYsys_id
```

The `^NQ` is ServiceNow's OR operator. This is the `(timestamp, id)` keyset pattern again.

### Deletion via Audit Log

ServiceNow captures deletes in the `sys_audit` table (`fieldname=DELETED`). In the production system, this runs as a separate parallel stream using `(sys_created_on, sys_id)` keyset pagination.

**In Workers (single stream):** Model this as a flip-flop. The main delta stream runs until `hasMore: false` (caught up), then the state switches to the delete stream for a cycle, then back. See the "Stream Flip-Flop" pattern below.

### Completion Detection Difference

- **Backfill:** continues until an empty page (`records.length == 0`)
- **Delta:** stops when a page is not full (`records.length < limit`)

This is a subtle but important distinction. Backfill is exhaustive; delta assumes a non-full page means "caught up."

### Cursor Design

With separate syncs, the backfill cursor is simple. The delta sync uses a flip-flop state for delete detection:

```ts
// Backfill cursor (within-cycle pagination for replace mode)
type ServiceNowBackfillState = {
  afterTimestamp: string | null
  afterId: string | null
}

// Delta cursor (flip-flop between changes and deletes)
type ServiceNowDeltaState =
  | {
      phase: "delta"
      afterTimestamp: string
      afterId: string
      deletesCursor?: { afterCreatedOn: string; afterId: string }
    }
  | {
      phase: "deletes"
      afterCreatedOn: string
      afterId: string
      deltaCursor: { afterTimestamp: string; afterId: string }
    }
```

---

## APIs Without Change Tracking

Some APIs (Linear, Airtable) have no `updated_at`, no change feed, and no deletion webhook. For these, **use `mode: "replace"`**. The runtime handles the full sweep automatically: each cycle returns the complete dataset, and anything not returned gets deleted.

Replace mode is the right choice when:

- The API provides only opaque cursor pagination with no timestamp filtering
- Total records are manageable (< ~50k, depending on schedule interval)
- You need deletion detection but the API provides no delete signal

The state in replace mode is just within-cycle pagination (e.g., `{ offset: string }`) and effectively resets between cycles.

---

## Cross-Cutting Patterns

These patterns recur across multiple sources. They're the building blocks of cursor design.

### Pattern 1: Keyset Pagination `(timestamp, id)`

**Used by:** Salesforce, ServiceNow

The correct way to paginate a mutable dataset ordered by timestamp. Two columns form the cursor: the timestamp and a unique ID that breaks ties. The query uses an OR condition:

```
WHERE ts > :cursorTs OR (ts = :cursorTs AND id > :cursorId)
ORDER BY ts, id
```

**When to use:** Any API that lets you query with inequality filters on a timestamp and sort by it. Particularly important when multiple records can share the same timestamp (batch imports, bulk updates).

**Workers implementation:**

```ts
type KeysetCursor = { cursorTimestamp: string; cursorId: string }

const lastRecord = records[records.length - 1]
const nextState: KeysetCursor = {
  cursorTimestamp: lastRecord.updatedAt,
  cursorId: lastRecord.id,
}
```

### Pattern 2: Consistency Buffer

**Used by:** Salesforce (15s), Stripe (10s), HubSpot (10s)

Never advance the cursor to "now." Always leave a gap. Eventually consistent APIs may not surface recent writes in query results immediately. Because the cursor never resets in incremental mode, if it advances past a record that hasn't been indexed yet, that record is lost permanently.

The buffer ensures the cursor stays behind the API's consistency frontier.

**Workers implementation:**

```ts
const bufferMs = 15_000 // 15 seconds
const maxCursor = new Date(Date.now() - bufferMs).toISOString()
const nextCursor =
  records.length > 0 ? min(lastRecord.updatedAt, maxCursor) : maxCursor
```

### Pattern 3: Event Anchor (Backfill-to-Delta Transition)

**Used by:** Stripe, Salesforce, HubSpot

Before starting a backfill, snapshot the current position of the change feed (event ID, timestamp, etc.). The delta sync should start from that snapshot — not from the end of the backfill data.

**Why:** The backfill may take hours. Records change during that time. Without the anchor, changes between "backfill started" and "backfill ended" are lost permanently (since the cursor never goes backwards).

**v2 SDK note:** With separate backfill and delta syncs, the event anchor is handled by starting the delta sync before or concurrently with the backfill. The delta sync's cursor naturally captures the starting point. If you need explicit coordination, snapshot the event anchor before triggering the backfill and initialize the delta sync's cursor from it.

**Workers implementation:**

```ts
// Snapshot the anchor before triggering the backfill
const eventAnchor = await getLatestEventId()
// Initialize the delta sync's cursor to start from this anchor
// The backfill (replace, manual) handles seeding all existing data
```

### Pattern 4: Sweep = Replace Mode

When an API has no `updated_at`, no change feed, and no deletion signal, use `mode: "replace"`. The runtime handles the full sweep and deletion detection automatically. You just return all records each cycle.

### Pattern 5: Multi-Phase State Machine

**Used by:** HubSpot (deadlock handling), ServiceNow (flip-flop deletes)

Model the state as a discriminated union when a single sync needs multiple phases:

```ts
type State =
  | { phase: "delta"; cursor: string }
  | { phase: "deadlock"; stuckAt: number; lastId: string; resumeCursor: string }
```

Each `execute` call checks `state.phase` and runs the appropriate logic. In the v2 SDK, backfill and delta are typically **separate syncs** (backfill as `replace` + `manual`, delta as `incremental`), so the state machine within a single sync is simpler. Multi-phase state machines are still useful for edge cases within a delta sync (deadlock handling, flip-flop deletes).

### Pattern 6: Stream Flip-Flop (Single-Stream Delete Detection)

**Used by:** ServiceNow (adapted for single-stream Workers)

When an API exposes deletions through a separate endpoint (audit log, archived filter, trash), but you only have one `execute` function, alternate between streams:

1. Run the main delta stream until `hasMore: false` (caught up to present)
2. Switch to the delete-detection stream for one or more cycles
3. When the delete stream catches up, switch back to delta

The state carries cursors for both streams, plus which one is active:

```ts
type State =
  | { phase: "delta"; deltaCursor: string; deletesCursor?: string }
  | { phase: "deletes"; deltaCursor: string; deletesCursor: string }

// In execute:
if (state.phase === "delta") {
  const { records, hasMore } = await fetchChanges(state.deltaCursor)
  if (!hasMore) {
    // Delta caught up — flip to deletes on next cycle
    return {
      changes: records.map(toUpsert),
      hasMore: false,
      nextState: {
        phase: "deletes",
        deltaCursor: nextCursor,
        deletesCursor: state.deletesCursor ?? "",
      },
    }
  }
  // ... continue delta
}

if (state.phase === "deletes") {
  const { deletedIds, hasMore } = await fetchDeletedRecords(state.deletesCursor)
  if (!hasMore) {
    // Deletes caught up — flip back to delta
    return {
      changes: deletedIds.map((id) => ({ type: "delete", key: id })),
      hasMore: false,
      nextState: {
        phase: "delta",
        deltaCursor: state.deltaCursor,
        deletesCursor: nextCursor,
      },
    }
  }
  // ... continue deletes
}
```

The flip happens at cycle boundaries (`hasMore: false`). The next cycle picks up with the alternate stream. Both cursors advance independently and persist across cycles.

---

## Decision Tree: Choosing a Pagination Strategy

This tree applies to **backfill** pagination. Delta pagination often differs (see per-source sections).

```
Does the API provide pagination?
├─ No → Return all data in one batch (small datasets only)
│
├─ Yes, opaque cursor token (GraphQL endCursor, Stripe starting_after)
│  └─ Use the token directly in state
│     State: { cursor: string | null }
│
├─ Yes, page numbers or offsets
│  └─ Use page number in state
│     State: { page: number }
│
└─ Yes, timestamp-based query (updated_since, modified_after)
   ├─ Can multiple records share the same timestamp?
   │  ├─ No → Simple timestamp cursor
   │  │  State: { cursor: string }
   │  │
   │  └─ Yes → Keyset cursor (timestamp + id)
   │     State: { cursorTimestamp: string, cursorId: string }
   │
   └─ Always add a consistency buffer (10-60s behind now)
      APIs tend to be eventually consistent — safe default
```

For **delta** pagination, the main question is: does the API have a change feed?

```
Does the API have an events/changelog endpoint?
├─ Yes → Use event ID as delta cursor (Stripe pattern)
│  Anchor the latest event ID before backfill starts
│
├─ No, but has updated_at / modified_since filter
│  └─ Use timestamp (or keyset) as delta cursor (Salesforce pattern)
│     Apply consistency buffer
│
└─ No change tracking at all
   └─ Use replace mode instead of incremental
```

---

## Decision Tree: Choosing Replace vs Incremental Mode

```
Does the API support change tracking (updated_at / modified_since / change feed)?
├─ No → replace (simpler, auto-handles deletes)
│
├─ Yes → backfill (replace, manual) + delta (incremental, scheduled)
│  │
│  │  The backfill sync seeds the database on-demand.
│  │  The delta sync keeps it up-to-date on a schedule.
│  │  Both target the same worker.database() handle.
│  │
│  └─ Does the API support deletion detection?
│     ├─ Yes (archived filter, audit log, events) → delta sync with flip-flop deletes
│     ├─ No, but deletions matter → replace only (re-fetches everything, catches deletes)
│     └─ No, and deletions don't matter → incremental delta (accept stale records)
```

---

## Summary Table

| Source     | API Type  | Backfill Pagination     | Delta Strategy           | Key Pattern                                  |
| ---------- | --------- | ----------------------- | ------------------------ | -------------------------------------------- |
| Salesforce | REST/SOQL | Keyset (timestamp, id)  | Keyset on SystemModstamp | Consistency buffer (15s), overlap transition |
| Stripe     | REST      | `starting_after` cursor | Event feed (10s buffer)  | Event anchor before backfill                 |
| HubSpot    | REST      | Opaque `after` token    | Search API + timestamp   | Deadlock detection & resolution              |
| GitHub     | GraphQL   | Relay `endCursor`       | N/A (use replace mode)   | Two-level nested pagination                  |
| ServiceNow | REST      | Keyset (timestamp, id)  | Same keyset              | Flip-flop delete stream via audit log        |
