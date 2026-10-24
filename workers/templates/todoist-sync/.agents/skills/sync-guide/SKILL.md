---
name: sync-guide
description: Comprehensive guide to building Notion Workers syncs — covers the two-sync architecture (backfill+delta), replace mode, pagination, consistency buffers, pacers, deletion strategies, and common pitfalls. Auto-loads when sync-related work is detected.
user-invocable: false
---

## What is a Sync?

A sync is a recurring `execute` function that returns data changes to populate a Notion database. The runtime calls `execute` in a loop:

```ts
const db = worker.database("myDb", {
  type: "managed",
  initialTitle: "My Data",
  primaryKeyProperty: "ID",
  schema: {
    properties: {
      Name: Schema.title(),
      ID: Schema.richText(),
    },
  },
})

worker.sync("mySync", {
  database: db,
  execute: async (state, { notion }) => ({
    changes: [
      {
        type: "upsert",
        key: "1",
        properties: {
          Name: Builder.title("Item 1"),
          ID: Builder.richText("1"),
        },
      },
    ],
    hasMore: false,
    nextState: undefined,
  }),
})
```

Each call returns `{ changes, hasMore, nextState }`. If `hasMore` is `true`, the runtime calls `execute` again with `nextState`. This continues until `hasMore` is `false`, completing a **cycle**. The next cycle begins at the scheduled interval with the state from the end of the previous cycle.

**Imports:**

```ts
import { Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"
```

## Decision Framework

### Step 1: Choose an Architecture

The deciding factor is **API capability and dataset size**. Two tiers:

| Condition                                                         | Architecture                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| Small source (<1k records) or API with no change tracking         | **Simple replace sync** — one sync, `mode: "replace"`              |
| Everything else (API supports `updated_at`, change feeds, events) | **Backfill + delta pair** — two syncs writing to the same database |

**Simple replace sync**: One sync returns the full dataset each cycle. After the final `hasMore: false`, any records not seen are deleted automatically. Use when the dataset is small enough to re-fetch entirely.

**Backfill + delta pair**: Two syncs share a single database. The **backfill sync** (`mode: "replace"`, `schedule: "manual"`) re-fetches everything when triggered. The **delta sync** (`mode: "incremental"`, frequent schedule) fetches only changes since the last run. This separates concerns cleanly — no bi-modal state machine, no backfill-to-delta transition bugs.

Initialize the delta cursor before starting the backfill. When both syncs can
write the same record, include `upstreamUpdatedAt` on each upsert so a stale
backfill response cannot overwrite a newer delta response.

### Step 2: Understand Your API's Pagination

Most APIs require paginating through results. Return batches of ~100 changes. Returning too many changes in one `execute` call will fail.

**Backfill pagination** (full dataset load):

1. **Opaque cursor token** — GraphQL `endCursor`, Stripe `starting_after`
2. **Page number / offset** — `?page=N&limit=100`
3. **Keyset (timestamp + id)** — `WHERE created_at > X OR (created_at = X AND id > Y)` — the gold standard for timestamp-sorted mutable data

**Delta pagination** (change-only loads, incremental mode):

1. **Timestamp cursor** — `?updated_since=<cursor>` with consistency buffer
2. **Keyset on updated_at + id** — same keyset pattern on the modification timestamp
3. **Event/changelog feed** — `GET /events?after=<eventId>`
4. **Same opaque cursor** — when the API sorts by `updated_at`, the backfill cursor works for delta too

### Step 3: Consistency Buffer (Delta Syncs)

APIs tend to be eventually consistent. A record that was just written or updated may not appear in query results immediately. Since the cursor never resets in incremental mode, if it advances past a record that hasn't been indexed yet, that record is skipped permanently. Lag the cursor 10-60 seconds behind "now":

```ts
const bufferMs = 15_000
const maxCursor = new Date(Date.now() - bufferMs).toISOString()
function minTimestamp(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b
}

const nextCursor =
  records.length > 0 ? minTimestamp(lastRecord.updatedAt, maxCursor) : maxCursor
```

### Step 4: Deletion Strategies

1. **Backfill sync (replace mode)**: free — unseen records are auto-deleted each cycle. This is the primary mechanism for handling deletes when the API has no delete signal.
2. **Delta sync with delete API**: emit `{ type: "delete", key }` markers. If the delete signal comes from a separate endpoint (audit log, archived filter), use the **flip-flop pattern**: run the main delta stream until caught up (`hasMore: false`), then switch to the delete stream for a cycle, then back. Both cursors persist in state independently.
3. **No delete API, large dataset**: rely on the backfill sync's replace-mode mark-and-sweep. Trigger the backfill manually or on a slow schedule to clean up stale records.

## Replace Mode

Simple: fetch everything, return it all, let the runtime handle deletes. Use as a standalone sync for small sources, or as the backfill half of a backfill+delta pair.

```ts
const db = worker.database("records", {
  type: "managed",
  initialTitle: "Records",
  primaryKeyProperty: "ID",
  schema: {
    properties: { Name: Schema.title(), ID: Schema.richText() },
  },
})

const apiPacer = worker.pacer("myApi", {
  allowedRequests: 10,
  intervalMs: 1000,
})

worker.sync("recordsBackfill", {
  database: db,
  mode: "replace",
  schedule: "manual", // trigger manually or on a slow schedule
  execute: async (state) => {
    const page = state?.page ?? 1
    await apiPacer.wait()
    const { items, totalPages } = await fetchPage(page, 100)
    const hasMore = page < totalPages
    return {
      changes: items.map((item) => ({
        type: "upsert" as const,
        key: item.id,
        properties: {
          Name: Builder.title(item.name),
          ID: Builder.richText(item.id),
        },
      })),
      hasMore,
      nextState: hasMore ? { page: page + 1 } : undefined,
    }
  },
})
```

See `examples/replace-simple.ts` and `examples/replace-paginated.ts` for complete working examples.

## Incremental Mode (Delta Sync)

The delta sync fetches only changes since the last run. When paired with a replace-mode backfill sync on the same database, this replaces the old bi-modal single-sync pattern.

```ts
// Reuses the same `db` and `apiPacer` from above

worker.sync("recordsDelta", {
  database: db,
  mode: "incremental",
  schedule: "5m",
  execute: async (state: { cursor: string } | undefined) => {
    const cursor = state?.cursor ?? new Date(0).toISOString()
    const bufferTs = new Date(Date.now() - 15_000).toISOString()

    await apiPacer.wait()
    // fetchChanges must apply bufferTs as an upstream upper bound.
    const { items, nextCursor } = await fetchChanges(cursor, bufferTs)
    const done = !nextCursor

    return {
      changes: items.map(toUpsert),
      hasMore: !done,
      nextState: {
        // This example assumes nextCursor is an ISO timestamp. Opaque cursors
        // must not be compared with the timestamp buffer.
        cursor: done
          ? minTimestamp(nextCursor ?? cursor, bufferTs)
          : nextCursor,
      },
    }
  },
})
```

**Key points:**

- The delta sync's state is simple — just a cursor. No phase discrimination needed.
- The backfill sync (replace mode) handles the initial full load and periodic cleanup of deleted records.
- Both syncs write to the same database via the shared `db` handle.
- The pacer is shared between syncs — the server apportions the budget evenly.

See `examples/incremental-basic.ts`, `examples/incremental-bimodal.ts`, and `examples/incremental-events.ts` for complete patterns.

## Schema Reference

Define the Notion database shape with `Schema` types and build values with `Builder`:

| Schema type                      | Builder value                              | Notes                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Schema.title()`                 | `Builder.title("text")`                    | Primary display field. Every schema needs exactly one.                                                                                                                                    |
| `Schema.richText()`              | `Builder.richText("text")`                 | Text content, IDs                                                                                                                                                                         |
| `Schema.url()`                   | `Builder.url("https://...")`               | URL field                                                                                                                                                                                 |
| `Schema.email()`                 | `Builder.email("a@b.com")`                 | Email field                                                                                                                                                                               |
| `Schema.phoneNumber()`           | `Builder.phoneNumber("+1...")`             | Phone field                                                                                                                                                                               |
| `Schema.checkbox()`              | `Builder.checkbox(true)`                   | Boolean                                                                                                                                                                                   |
| `Schema.file()`                  | `Builder.file("https://...", "name")`      | File URL + optional display name                                                                                                                                                          |
| `Schema.number()`                | `Builder.number(42)`                       | Number. Optional format: `Schema.number("percent")`                                                                                                                                       |
| `Schema.date()`                  | `Builder.date("2024-01-15")`               | Date (YYYY-MM-DD). Also: `Builder.dateTime("2024-01-15T10:30:00Z")`, `Builder.dateRange(start, end)`                                                                                      |
| `Schema.select([...])`           | `Builder.select("Option A")`               | Single select. Define options: `Schema.select([{ name: "A" }, { name: "B" }])`. **Options must have non-empty `name` values** — `Schema.select([])` and `{ name: "" }` are not supported. |
| `Schema.multiSelect([...])`      | `Builder.multiSelect("A", "B")`            | Multi select                                                                                                                                                                              |
| `Schema.status(...)`             | `Builder.status("Done")`                   | Status with groups                                                                                                                                                                        |
| `Schema.people()`                | `Builder.people("email@co.com")`           | People by email                                                                                                                                                                           |
| `Schema.place()`                 | `Builder.place({ lat: 40.7, lon: -74.0 })` | Geographic location                                                                                                                                                                       |
| `Schema.relation("databaseKey")` | `[Builder.relation("pk")]`                 | Relation to another managed database. Value is an **array**.                                                                                                                              |

Relations use the related database key. Two-way relations are configured the same way:

```ts
Schema.relation("otherDatabase", {
  twoWay: true,
  relatedPropertyName: "Back Link",
})
```

Row-level icons and page content:

```ts
changes: [
  {
    type: "upsert",
    key: "1",
    properties: {
      Name: Builder.title("Example"),
      // ... other properties ...
    },
    icon: Builder.emojiIcon("🎯"), // or Builder.notionIcon("rocket", "blue")
    pageContentMarkdown: "## Details\nSome text", // Markdown body for the page
  },
]
```

## Common Mistakes

1. **Not using a pacer** — every API call inside `execute` should be preceded by `await apiPacer.wait()`. Without it, syncs will hit rate limits and fail.
2. **Missing consistency buffer on delta syncs** — the cursor will permanently skip records not yet indexed in eventually consistent APIs.
3. **Not paginating** — returning too many changes at once. Start with batches of ~100.
4. **Using replace mode for large datasets** — if the API supports change tracking, pair a replace-mode backfill sync with an incremental delta sync instead of re-fetching everything each cycle.
5. **Cursor that doesn't advance** — infinite loop. Ensure `nextState` changes between iterations.
6. **Forgetting first-run handling** — `state` is `undefined` on first call. Use `state?.cursor ?? null`.
7. **Forgetting that backfill + delta share a database** — both syncs must use the same `worker.database()` handle and the same key/properties shape.
8. **Not triggering the backfill sync** — the backfill sync with `schedule: "manual"` won't run automatically. Trigger it on deploy or periodically to clean up deleted records.
9. **Empty select values** — `Schema.select()` requires at least one option with a non-empty `name`. `Schema.select([])` and `{ name: "" }` are not supported.

## CLI Commands for Sync Development

```shell
# Deploy
ntn workers deploy

# Preview (test without writing)
ntn workers sync trigger <key> --preview
ntn workers sync trigger <key> --preview --context '<json>'  # continue pagination

# Trigger a sync run
ntn workers sync trigger <key>

# Check sync status
ntn workers sync status

# View run logs
ntn workers runs list
ntn workers runs list --plain | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}

# Reset state (full re-backfill)
ntn workers sync state reset <key>

# Manage secrets
ntn workers env set KEY=value
ntn workers env push
```

## API Patterns Reference

See [api-pagination-patterns.md](./api-pagination-patterns.md) for detailed strategies drawn from production syncs with Salesforce, Stripe, HubSpot, GitHub, and ServiceNow.
