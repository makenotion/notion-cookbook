# Worker sync: Readwise and Reader

Turn your reading activity into a connected Notion knowledge base. This Worker
creates managed databases for sources and highlights, relates every highlight
to its source, and keeps both current with Readwise and Reader.

Readwise and Reader remain the places to save, organize, highlight, and review.
This recipe is read-only and leaves the Notion page bodies available for your
own notes and writing.

## Quickstart

You need Node.js 22+, npm 10.9.2+, a Readwise account with API access, and a
personal [Readwise access token](https://readwise.io/access_token). The same
token authenticates the Readwise and Reader APIs.

From the repository root:

```sh
npm install --global ntn@latest
cd workers/readwise-sync
npm install
ntn login
ntn workers deploy --name readwise-sync
ntn workers sync pause sourcesSync
ntn workers sync pause highlightsSync
ntn workers sync pause sourcesReconciliationSync
ntn workers sync pause highlightsReconciliationSync
export READWISE_ACCESS_TOKEN=your-token
export READWISE_CREDENTIAL_FINGERPRINT="$(npm run --silent credential:fingerprint)"
ntn workers env set \
  READWISE_ACCESS_TOKEN="$READWISE_ACCESS_TOKEN" \
  READWISE_CREDENTIAL_FINGERPRINT="$READWISE_CREDENTIAL_FINGERPRINT"
unset READWISE_ACCESS_TOKEN READWISE_CREDENTIAL_FINGERPRINT
```

Use `--name readwise-sync` only for the first deployment. After `workers.json`
identifies the deployed Worker, update it with `ntn workers deploy`.

Keep the schedules paused while you configure and review the deployment.
Highlights, notes, tags, document titles, URLs, and reading activity can reveal
private interests or routines. Review both managed databases' Notion sharing
settings before writing data. Preview output contains the same sensitive reading
context, so protect terminal output and logs.

Preview the initial backfills without writing to Notion:

```sh
ntn workers sync trigger sourcesSync --preview
ntn workers sync trigger highlightsSync --preview
```

Populate Sources first, then wait for it to succeed so Highlight relations can
resolve immediately:

```sh
ntn workers sync trigger sourcesSync
ntn workers sync status sourcesSync
```

When Sources succeeds, press Ctrl-C and populate Highlights:

```sh
ntn workers sync trigger highlightsSync
ntn workers sync status highlightsSync
```

When Highlights succeeds, press Ctrl-C. Initialize the Source deletion
safeguard. It verifies complete inventories before removing unseen rows:

```sh
ntn workers sync trigger sourcesReconciliationSync
ntn workers sync status sourcesReconciliationSync
```

When it succeeds, press Ctrl-C and initialize the Highlight safeguard:

```sh
ntn workers sync trigger highlightsReconciliationSync
ntn workers sync status highlightsReconciliationSync
```

When it succeeds, press Ctrl-C. Review both databases, then start the recurring
schedules:

```sh
ntn workers sync resume sourcesSync
ntn workers sync resume highlightsSync
ntn workers sync resume sourcesReconciliationSync
ntn workers sync resume highlightsReconciliationSync
```

The first run of each incremental sync backfills all available history.
Subsequent changes sync every 15 minutes, and daily reconciliation repairs
omissions and removals. No `NOTION_API_TOKEN` is needed; the Workers platform
handles Notion authentication.

The separately stored fingerprint binds the deployment to the configured token
and is verified before every API request. Capability state also pins it across
retries. To sync another account, create a separate deployment and managed
databases rather than resetting state and changing both values on an existing
deployment.

## What you can answer

| Managed database       | Questions it helps answer                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Reading Sources**    | What is in my Reader inbox or archive? Which books and articles have I not finished? What have I saved by author, site, topic, or type? |
| **Reading Highlights** | Which ideas have I saved or annotated recently? What are my favorite highlights, and which source or topic do they support?             |

The result is richer than a flat highlight export: Reader documents and sources
imported from Kindle, Apple Books, Instapaper, and other services share one
source database, with every highlight connected by a Notion relation.

Add a Project relation or other workflow properties directly in Notion when you
want to connect reading to active work. The Worker preserves user-added
properties and page content.

## Reference

### Why the Worker uses two APIs

Readwise exposes two related data models:

- The [Reader Document LIST API](https://readwise.io/reader_api) provides the
  Reader library, including inbox location, archive state, reading progress,
  reading time, and document metadata. The Worker keeps only top-level records
  whose `parent_id` is null, so nested notes and highlights are not duplicated
  as Sources.
- The [Readwise Highlight EXPORT API](https://readwise.io/api_deets#export)
  provides source containers and highlights from every service connected to
  Readwise. For a Reader source, its documented `external_id` is the Reader
  document ID, which lets the Worker relate exported highlights to the richer
  Reader Source row.

A Kindle book therefore appears as a Source even if it was never saved to
Reader. A Reader article with Readwise highlights appears once, with its
highlights related to that row.

### Synced databases and schedules

| Database               | Key contents                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Reading Sources**    | Source, location, reading progress, category, author, site, tags, links, notes, and reading dates          |
| **Reading Highlights** | Highlight, source relation, note, tags, highlighted date, favorite state, links, quote, and source context |

| Capability                     | Mode        | Schedule     | Purpose                                               |
| ------------------------------ | ----------- | ------------ | ----------------------------------------------------- |
| `sourcesSync`                  | Incremental | Every 15 min | Changed Reader documents and Readwise sources         |
| `highlightsSync`               | Incremental | Every 15 min | New, edited, and explicitly deleted highlights        |
| `sourcesReconciliationSync`    | Replace     | Daily        | Complete Reader and Readwise source repair            |
| `highlightsReconciliationSync` | Replace     | Daily        | Complete highlight repair and deletion reconciliation |

Sources use deterministic `reader:<id>` or `readwise:<user_book_id>` keys.
Highlights use `highlight:<id>`. Replaying a provider page therefore updates
the same Notion rows, and relations remain stable when display names change.
On a unified Reader Source, Reader owns shared metadata and Reader-specific
fields; Readwise Export owns **Readwise Review** and **Readwise Source ID**.
Reconciliation clears fields owned by a representation that has disappeared.

Quote, note, and summary properties are bounded to 1,900 Unicode characters.
The corresponding **Truncated** checkbox discloses shortened values, and links
back to Readwise preserve access to the full source. Tag values are normalized
into deterministic options; commas become full-width commas (`，`) because the
current multi-select wire format uses commas as separators. More than 100 tags
or a tag longer than 100 characters fails visibly instead of dropping data.

### How it works

1. Each API request fetches and transforms one provider page before its
   `pageCursor` is saved. Incremental cursor loops restart the same pinned
   traversal up to three times; malformed cursors and incompatible state fail
   closed. Incremental traversals cap at 10,000 cursor pages. Daily inventory
   phases cap at 2,048 cursor pages, 10,000 records per inventory, and 30,000
   bounded uniqueness checks.
2. An incremental cycle pins one `updatedAfter` value and advances its
   checkpoint only after every page succeeds. The next cycle overlaps the
   checkpoint by five minutes to replay equal timestamps, indexing lag, and
   records fetched after the checkpoint; neither API supports an
   `updatedBefore` bound.
3. Reader and Readwise Export can update the same `reader:<id>` Source
   independently. Each update writes only the fields its API owns.
4. Daily replacement scans require two consecutive complete inventories to
   match before a verified emission pass can delete unseen rows. Readwise does
   not document whether Export `count` measures source containers or nested
   highlights, so the Worker records both, accepts only a matching completed
   inventory, and requires the same count unit across all three passes. Empty
   source containers require source-count proof. Partial, duplicate, or changing
   scans do not delete data.
5. All capabilities share a conservative pacer of 15 requests per minute,
   below Reader's documented 20 requests per minute. Provider `429` responses
   preserve `Retry-After` for the Worker runtime.

This design favors eventual convergence over webhook-like latency. Provider
indexing, a failed run, rate limiting, and the 15-minute schedule can delay an
update.

Source-reconciliation capacity depends on library shape because one bounded
guard covers Reader documents, Readwise source IDs, unified Notion keys, and
nested highlight IDs. It fits 7,500 fully unified Sources with one highlight
each; libraries with less overlap may fit up to 10,000 records in an individual
inventory. Exceeding either bound fails before replacement deletion.

### Deletion and data safety

- Moving a Reader document to archive is not deletion. The Source remains, its
  location changes, and **Archived** is checked.
- Incremental Export requests include deleted highlights; explicit highlight
  tombstones become Notion delete changes.
- A deleted non-Reader source, such as a Kindle or Apple Books container,
  becomes a Notion delete on the next incremental Source sync.
- Reader LIST has no hard-deletion tombstone. Daily reconciliation removes a
  missing Reader document unless its Readwise source or highlights still make
  it a useful source container.
- A deleted Reader-backed Readwise container does not immediately delete the
  unified Reader row. Reader is authoritative for that identity; daily
  two-source reconciliation decides whether the Source remains.
- Whole-source deletion may not enumerate every former highlight. Daily
  Highlight reconciliation is the final repair for missing tombstones.
- Deleting a managed row also removes its page body and user-added property
  values. Archive upstream records when that Notion context must survive, or
  keep durable commentary in a separate related database.

For retained rows, the Worker writes only its declared managed properties and
never writes page body content. User-added properties, views, and page bodies
remain outside its write set.

Reader-backed identity depends on Readwise's documented `external_id`. If a
Reader source returns it as null or empty, the Worker creates a separate
`readwise:<user_book_id>` Source rather than guessing from a title or URL.

### Project structure

```text
src/
├── credential.ts  — token fingerprinting and validation
├── index.ts       — databases, schedules, and shared pacing
├── readwise.ts    — typed clients and response validation
├── state.ts       — cursor guards, checkpoints, and overlap transitions
├── syncs.ts       — incremental and replacement page executors
├── sources.ts     — Source schema, keys, and transforms
├── highlights.ts  — Highlight schema, relations, deletes, and transforms
└── values.ts      — bounded text, tags, dates, URLs, and labels
credential-fingerprint.ts — local fingerprint command
test.ts                   — inline fixtures and offline tests
```

### Adapt the recipe

- Change schedules in `src/index.ts` for a slower personal archive. Keep the
  shared pacer within Reader's published limit.
- Add a Source or Highlight field by validating it in `src/readwise.ts`, adding
  the schema and transform value in the resource file, and covering populated
  and missing values in tests.
- Add formulas, rollups, or a related Authors database when those relationships
  are useful to your workflow.
- Add Worker-owned page content for longer source text only if you want later
  syncs to own and update that content. This recipe leaves page bodies alone.
- Add webhook-triggered freshness only after designing for signature/secret
  handling, retries, replay, and reconciliation. Readwise's current event list
  does not replace polling for both complete datasets.

If a code change alters source selection, key construction, response parsing,
or state shape, bump `SYNC_STATE_VERSION` and reset the affected capability
state after deployment.

Rotating a token for the same account also requires an explicit rebind: pause
all four capabilities, generate and store the new token fingerprint, reset all
four capability states, and repeat the preview and initialization sequence
above before resuming. Updating both values and resetting state is explicit
authorization to rebind, so do not use that procedure to switch accounts on an
existing deployment.

### Local testing

Tests use fixed fixtures and do not contact Readwise, Reader, or Notion. From
the repository root:

```sh
cd workers/readwise-sync
npm install
npm run check
npm test
npm run build
```

They cover endpoint parameters, response validation, bounded reads,
non-disclosing errors, identities and relations, deletion tombstones, text and
tag bounds, cursor cycles, checkpoint overlap, failure replay, and daily
reconciliation.

## Learn more

- [Notion sync guide](https://developers.notion.com/workers/guides/syncs)
- [Reader API](https://readwise.io/reader_api)
- [Readwise API and Highlight EXPORT](https://readwise.io/api_deets#export)
- [Readwise and Reader webhooks](https://docs.readwise.io/readwise/docs/webhooks)
- [Contributing guide](../../CONTRIBUTING.md)
