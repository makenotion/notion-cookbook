# Readwise and Reader sync

Turn your reading activity into a durable Notion knowledge base. This Worker
keeps two related managed databases current:

- **Reading Sources** is your Reader library plus source containers for
  highlights imported into Readwise from Kindle, Apple Books, Instapaper, and
  other services.
- **Reading Highlights** contains the quotes, notes, tags, locations, and
  source relationships that make those ideas useful in projects and writing.

The result is more useful than a flat highlight export. You can build views for
the Reader inbox, unfinished long reads, favorite highlights, recently updated
notes, books by topic, or every highlight related to one source.

This is a read-only V1. It reads Readwise and Reader APIs but never creates,
updates, archives, or deletes data in either service.

## Why there are two upstream APIs

Readwise exposes two related but different data models:

1. The [Reader Document LIST API](https://readwise.io/reader_api) returns the
   Reader library, including inbox location, archive state, progress, reading
   time, and document metadata. Reader also represents its highlights and
   notes as documents. This recipe keeps only top-level records whose
   `parent_id` is null, so nested annotations are not duplicated as Sources.
2. The [Readwise Highlight EXPORT API](https://readwise.io/api_deets#export)
   returns source containers and highlights from every service connected to
   Readwise. For a Reader-backed source, its documented `external_id` is the
   Reader document ID. The Worker uses that ID to relate the highlight to the
   richer Reader Source row.

A Kindle book may therefore appear as a Source even when it was never saved to
Reader. A Reader article with Readwise highlights appears once, with those
highlights related to it.

## What the Worker maintains

### Reading Sources

| Property                  | Upstream value                                               |
| ------------------------- | ------------------------------------------------------------ |
| Name                      | Reader or Readwise source title                              |
| Origin                    | Reader or the Readwise import source, such as Kindle         |
| Category                  | Article, PDF, book, email, tweet, and similar categories     |
| Location                  | Reader inbox, later, shortlist, archive, or feed             |
| Archived                  | Whether the Reader document is in `archive`                  |
| Author / Site             | Document author and site                                     |
| Tags                      | Reader document tags or Readwise source tags                 |
| Original URL              | Original document URL                                        |
| Open in Reader            | Reader document URL                                          |
| Readwise Review           | Readwise source review URL                                   |
| Summary / Note            | Bounded upstream summary and document note                   |
| Reading Progress          | Reader progress from `0` to `1`                              |
| Word Count / Reading Time | Reader length estimates                                      |
| Published / Saved         | Reader publication and save times                            |
| Last Opened / Updated     | Reader activity timestamps                                   |
| Reader Document ID        | Stable Reader ID when the source exists in Reader            |
| Readwise Source ID        | Stable Readwise `user_book_id` when highlights were exported |
| Source Key                | Namespaced primary key used by syncs and relations           |
| Highlights                | Two-way relation created by the Highlights database          |

### Reading Highlights

| Property            | Upstream value                                    |
| ------------------- | ------------------------------------------------- |
| Name / Quote        | Searchable excerpt and highlight text             |
| Note                | The note attached to the highlight                |
| Source              | Relation to the Reading Sources row               |
| Source Title/Author | Denormalized context for filtering                |
| Origin              | Reader, Kindle, or another Readwise import source |
| Tags / Color        | Highlight organization metadata                   |
| Favorite/Discarded  | Readwise review state                             |
| Location/Type       | Location in the source and its coordinate type    |
| Highlighted         | When the highlight was taken                      |
| Created / Updated   | Readwise timestamps                               |
| Readwise URL        | Direct link to the highlight                      |
| Source URL          | Deep link or original source URL when available   |
| External ID         | Source-system highlight ID when available         |
| Readwise Source ID  | Parent `user_book_id`                             |
| Highlight Key       | Namespaced primary key, such as `highlight:9001`  |

Notion rich-text properties have practical size limits. Quote, note, and
summary values are bounded to 1,900 Unicode characters. The adjacent
`Truncated` checkbox makes that loss explicit, and the Readwise link remains
available for the full upstream value.

## Sync behavior and guarantees

| Capability                     | Mode        | Schedule | Purpose                                                 |
| ------------------------------ | ----------- | -------- | ------------------------------------------------------- |
| `sourcesSync`                  | Incremental | 15 min   | Reader document changes and changed Readwise sources    |
| `highlightsSync`               | Incremental | 15 min   | New, edited, and explicitly deleted Readwise highlights |
| `sourcesReconciliationSync`    | Replace     | Daily    | Full Reader and Readwise source repair sweep            |
| `highlightsReconciliationSync` | Replace     | Daily    | Full highlight repair and deletion sweep                |

The implementation makes these guarantees:

- Reader IDs, Readwise `user_book_id` values, and Readwise highlight IDs are
  namespaced deterministic keys. Replaying a page updates the same rows.
- Every API request fetches one provider page. `pageCursor` is persisted only
  after that page has been transformed successfully.
- An incremental cycle pins one `updatedAfter` value while traversing every
  `pageCursor`. It records a checkpoint before the first request and advances
  the watermark only after the final page succeeds.
- The next cycle starts five minutes before the checkpoint. This intentional
  overlap safely replays equal timestamps, provider indexing lag, and records
  fetched after the checkpoint because neither API supports an `updatedBefore`
  bound.
- Cursor cycles, malformed cursors, incompatible state, and runs above 10,000
  pages per phase fail closed instead of silently completing an unsafe sweep.
- Replacement rows are swept only after every page and both Source phases
  complete. A partial reconciliation does not delete unseen rows.
- Source scans read Readwise Export first and Reader second. When both APIs
  address the same `reader:<id>` row, the richer Reader title, tags, summary,
  note, and document metadata therefore win the final upsert.
- The Worker never writes page body content and only emits properties declared
  in its managed schemas. Views, page bodies, and user-added properties on
  retained rows remain outside this recipe's write set.

This recipe does not promise immediate delivery. Provider indexing, the
15-minute schedule, rate limiting, and a failed run can delay an update. The
overlap and daily reconciliation are designed for eventual convergence rather
than webhook-like latency.

## Deletions, archives, and known limits

These distinctions matter:

- **Reader archive is not deletion.** Moving a document to archive changes its
  `location`; the Source remains and `Archived` becomes checked.
- **Readwise highlight deletion is explicit.** Incremental export requests use
  `includeDeleted=true`, and `is_deleted` highlights become Notion delete
  changes.
- **A deleted Reader-backed Readwise container does not delete a Reader row.**
  Reader LIST is authoritative for the unified `reader:<id>` Source. The export
  phase ignores that source-level tombstone while still deleting its highlight
  rows; the next successful two-source replacement decides whether the Source
  itself still exists. Non-Reader source tombstones are deleted immediately.
- **Reader hard deletion has no tombstone in Document LIST.** A deleted Reader
  document can remain until the next successful daily replacement. If its
  Readwise source and highlights still exist, the Source remains as a useful
  Readwise source container.
- **Whole-source deletion may not enumerate every former highlight.** The daily
  Highlight replacement is the final repair mechanism for highlights missing
  from incremental tombstones.
- **Upstream deletion removes the managed Notion row.** An explicit tombstone
  or completed replacement sweep deletes that page, including its page-body
  notes and user-added property values. Archive the source instead, or keep
  durable commentary in a separate related database, when that context must
  outlive deletion from Readwise or Reader.
- **Tags are dynamic.** Reader and Readwise can introduce arbitrary tag names;
  the managed databases create select options as they appear. A record with
  more than 100 unique tags or a tag name above 100 characters fails visibly
  instead of silently dropping or shortening tags. Commas inside one source
  tag become visually similar full-width commas (`，`) because the Worker
  multi-select wire format uses commas as separators.
- **Reader-backed identity depends on `external_id`.** Readwise documents this
  field only for sources whose `source` is `reader`. If it is absent, the
  Worker safely creates a separate `readwise:<user_book_id>` Source rather than
  guessing from title or URL.

Readwise now documents custom webhooks, but the current event list does not
provide a complete create/update/delete feed for both datasets: it lists
`readwise.highlight.created` plus selected Reader document events. The webhook
secret is included in the POST payload. This V1 deliberately uses authenticated
polling and reconciliation instead of claiming complete webhook coverage. See
the [official webhook documentation](https://docs.readwise.io/readwise/docs/webhooks).

## Prerequisites

- Node.js 22 or newer
- npm 10.9.2 or newer
- The [Notion CLI](https://developers.notion.com/docs/get-started-with-notion-cli)
- A Readwise account with access to the APIs you intend to sync
- A personal [Readwise access token](https://readwise.io/access_token)

The same token authenticates both APIs with `Authorization: Token …`. This
Worker does not need a separate Notion API token because managed database
writes are handled by the Worker sync runtime.

Keep one deployment bound to one Readwise account. These APIs do not expose a
stable account ID that this recipe can verify before a replacement sweep.
Changing `READWISE_ACCESS_TOKEN` to a different account would make the prior
account's rows look deleted. Create a separate Worker deployment and managed
databases instead of repointing an existing deployment.

## Set up and deploy

From this directory:

```bash
npm install
npm run check
npm test
npm run build
ntn login
ntn workers deploy --name readwise-sync
ntn workers env set READWISE_ACCESS_TOKEN=your_token
```

Never commit the real token. `.env.example` contains only the variable name and
a safe placeholder.

## Run the first sync

Preview both incremental backfills before writing anything:

```bash
ntn workers sync trigger sourcesSync --preview
ntn workers sync trigger highlightsSync --preview
```

Then establish Source rows before their Highlight relations:

```bash
ntn workers sync trigger sourcesSync
ntn workers sync trigger highlightsSync
```

The first incremental run starts at the Unix epoch, so it is a complete
backfill. Later runs use the stored overlapping checkpoint. The daily
reconciliations begin automatically after deployment and repair omissions or
deletions.

Inspect progress and logs with:

```bash
ntn workers sync status
ntn workers runs list
ntn workers runs logs <run-id>
```

## Reset or repair state

Deploying new code preserves sync state. If a state contract changes or you
intentionally want to replay all history, reset and trigger the affected
incremental capability:

```bash
ntn workers sync state get sourcesSync
ntn workers sync state reset sourcesSync
ntn workers sync trigger sourcesSync

ntn workers sync state get highlightsSync
ntn workers sync state reset highlightsSync
ntn workers sync trigger highlightsSync
```

You can also trigger either replacement sweep immediately:

```bash
ntn workers sync trigger sourcesReconciliationSync
ntn workers sync trigger highlightsReconciliationSync
```

Run Sources first when repairing both databases so every relation target is
available before Highlights are refreshed.

## Rate limiting

Reader documents are documented at 20 requests per minute per access token;
Readwise documents a default base rate of 240 requests per minute for most v2
endpoints. All four capabilities share one conservative Worker pacer capped at
15 requests per minute. A provider `429` becomes a Workers `RateLimitError` and
preserves `Retry-After` so the runtime can retry appropriately.

Large libraries can therefore take multiple minutes to backfill. Do not raise
the pacer above Reader's published limit without confirming updated provider
terms.

## Code map

```text
src/
├── index.ts       Registers databases, schedules, and the shared pacer
├── readwise.ts    Typed Reader and Readwise clients and response validation
├── state.ts       Cursor guards, checkpoint pinning, and overlap transitions
├── syncs.ts       Incremental and replacement page executors
├── sources.ts     Source schema, stable keys, and transforms
├── highlights.ts  Highlight schema, relations, deletes, and transforms
└── values.ts      Bounded text, tags, dates, URLs, and display normalization
fixtures/
├── reader-page.json
└── export-page.json
test.ts            Deterministic offline API, state, and transform tests
```

## Adapt the recipe

Useful extensions include:

- Change the schedules in `src/index.ts` for a slower personal archive.
- Add rollups or formulas in Notion for highlight counts and unread queues.
- Add a third managed database for authors only if the relation is valuable to
  your workflow; author strings are intentionally simpler in V1.
- Store longer text in Worker-owned page content if you are willing to make
  that content provider-owned. V1 leaves page bodies untouched so users can
  write around synced records safely.
- Add a webhook capability only after choosing a complete event strategy and
  testing secret validation, retries, replay behavior, and reconciliation.

When changing source selection, key construction, response parsing, or state
shape, bump `SYNC_STATE_VERSION` and reset affected capability state after
deployment.

## Verify locally

The tests use fixed API fixtures and never require a Readwise token or Notion
workspace:

```bash
npm install
npm run check
npm test
npm run build
```

They cover authentication headers, endpoint parameters, response validation,
bounded response reads, non-disclosing errors, strict deletion flags, rate-limit
propagation, Reader child filtering, Reader/Readwise identity merging,
relations, deletion tombstones, tag and text bounds, cursor cycles, phase
transitions, checkpoint overlap, failure replay, and reconciliation behavior.

Live API calls and deployment are intentionally not part of the offline test
suite.

## Official API references

- [Reader API](https://readwise.io/reader_api)
- [Readwise API and Highlight EXPORT](https://readwise.io/api_deets#export)
- [Readwise and Reader webhooks](https://docs.readwise.io/readwise/docs/webhooks)
