# Worker sync: Readwise and Reader

Build a durable Notion research archive from what you save in Reader and
highlight through Readwise. This Worker creates two related managed databases:
one for sources and one for highlights, notes, tags, and favorites.

Use the archive to find unfinished reading, recover evidence for a project, or
queue ideas for synthesis. Reader and Readwise remain the places to collect and
review; the Worker never writes back to either service and never deletes a
Notion page.

## What you get

| Managed database       | What it gives you                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| **Reading Sources**    | Reader documents and Readwise sources with progress, location, author, site, tags, and links      |
| **Reading Highlights** | Highlights related to their Sources, with annotations, favorites, tags, dates, and source context |

Reader documents and sources imported from Kindle, Apple Books, Instapaper,
and other Readwise connections share one Source database. When Readwise
identifies a source as a Reader document, the Worker unifies the two records
instead of creating a duplicate. Every Highlight links to its Source.

## Quickstart

You need Node.js 22+, npm 10.9.2+, a Readwise account with API access, and one
personal [Readwise access token](https://readwise.io/access_token). The same
token authenticates the Reader and Readwise APIs.

From the repository root, deploy the Worker, then pause both schedules while
you verify it:

```sh
npm install --global ntn@latest
cd workers/readwise-sync
npm install
ntn login
ntn workers deploy --name readwise-sync
ntn workers sync pause sourcesSync
ntn workers sync pause highlightsSync
ntn workers env set READWISE_ACCESS_TOKEN=your-token
```

Use `--name readwise-sync` only for the first deployment. After `workers.json`
identifies it, update the Worker with `ntn workers deploy`.

One deployment is bound to one Readwise access token. If the token changes, the
Worker stops before reading or writing so two accounts cannot be mixed. Restore
the original token or use a separate deployment and databases for the new one.

Reading activity, highlights, notes, tags, titles, and URLs can reveal private
interests or routines. Review both databases' Notion sharing settings before
writing data. Preview output and logs contain the same sensitive context.

Preview the initial imports without writing to Notion:

```sh
ntn workers sync trigger sourcesSync --preview
ntn workers sync trigger highlightsSync --preview
```

Populate Sources first so Highlight relations resolve immediately:

```sh
ntn workers sync trigger sourcesSync
ntn workers sync status sourcesSync
```

When Sources succeeds, press Ctrl-C, then populate Highlights:

```sh
ntn workers sync trigger highlightsSync
ntn workers sync status highlightsSync
```

When Highlights succeeds, press Ctrl-C, review both databases, and resume the
recurring syncs:

```sh
ntn workers sync resume sourcesSync
ntn workers sync resume highlightsSync
```

The first run backfills available history. Both incremental syncs then check for
updates every 15 minutes. No `NOTION_API_TOKEN` is needed; the Workers platform
creates the databases and handles Notion authentication.

## Build useful views

These recipes turn the imported data into an opinionated reading workflow. Add
the suggested user-owned properties directly in Notion; the Worker preserves
them.

- **Unfinished Inbox:** In **Reading Sources**, filter **Location** to `Inbox`,
  **Reading Progress** to less than `100%`, and **Removed upstream** to
  unchecked. Sort **Saved** newest first.
- **Recent Highlights:** In **Reading Highlights**, filter **Highlighted** to
  the past month and **Removed upstream** to unchecked. Sort **Highlighted**
  newest first.
- **Favorites & Annotations:** In **Reading Highlights**, add an advanced filter
  where **Favorite** is checked _or_ **Note** is not empty, then require
  **Removed upstream** to be unchecked.
- **To Synthesize:** Add a `Synthesis Status` select to **Reading Highlights**
  with `To Synthesize` and `Synthesized`. Filter for `To Synthesize` and
  **Removed upstream** unchecked, then group by **Source** or **Tags**.
- **Project connection:** Add a `Project` relation from Highlights, Sources, or
  both to your Projects database. Create a linked view on each project filtered
  to that project so the evidence stays next to the work it supports.

## Archive-first by design

This recipe prioritizes preserving your accumulated knowledge over making
Notion an exact replica of the provider.

- Neither sync emits Notion delete changes.
- Readwise Highlight tombstones, discarded Highlights, and non-Reader Source
  tombstones check **Removed upstream** instead of deleting their pages.
- A Reader-backed Source tombstone leaves the unified Source active because its
  Reader document may still exist; absence from Reader is not treated as
  deletion.
- A record that is simply absent from a later provider response stays unchanged
  because absence is not reliable proof of deletion.
- There is no replacement or reconciliation sweep. Active views should filter
  **Removed upstream** to unchecked; archive views can keep everything visible.

The benefit is durable context: upstream cleanup, temporary API omissions, and
pagination changes cannot erase a Notion page or the work you added to it. The
tradeoff is that silently removed provider records can remain in Notion without
being marked. Delete or archive those rows manually only when you no longer need
their Notion context.

Reader's `Feed` location is excluded from the Reader document import by default.
Feeds can overwhelm an intentional reading archive with unread items; saving an
item into your library makes it useful here. Readwise sources represented in the
Highlight Export remain in scope. Change the Reader location filter if your use
case needs the complete feed. If an imported document is later moved back to
Feed, its existing archive row stays unchanged rather than being deleted.

## How Reader and Readwise become one archive

The [Reader Document LIST API](https://readwise.io/reader_api) supplies
top-level Reader documents, reading progress, location, and document metadata.
Nested Reader highlights and notes are skipped because the Readwise export is
the authoritative input for them.

The [Readwise Books LIST API](https://readwise.io/api_deets) refreshes titles,
authors, tags, and document notes for non-Reader sources with highlights. Reader
books are skipped here because this endpoint does not include the Reader
document ID needed to unify their rows.

The [Readwise Highlight EXPORT API](https://readwise.io/api_deets#export)
supplies source containers and highlights from every connected reading service.
For a Reader-backed source, Readwise's documented external ID links the export
record to the corresponding Reader document. Other sources, such as Kindle
books, receive their own stable Source row.

### Syncs and ownership

| Capability       | Managed database       | Input                               | Schedule     |
| ---------------- | ---------------------- | ----------------------------------- | ------------ |
| `sourcesSync`    | **Reading Sources**    | Reader documents + Readwise sources | Every 15 min |
| `highlightsSync` | **Reading Highlights** | Readwise highlights                 | Every 15 min |

Both capabilities are incremental. Stable keys keep updates and relations on
the same rows when titles change. Supported removal signals update **Removed
upstream**; neither capability deletes pages.

Reader and Readwise can update the same Source. Reader owns its document and
queue fields, Books LIST owns non-Reader metadata and links, and Highlight
Export owns summaries and explicit removal signals. **Source** is intentionally
shared so every API can keep the required title current and Export can name a
relation target first observed through a Highlight. Other endpoint-owned fields
remain untouched.

Tags longer than Notion's option limit receive a stable hash suffix. Records
with more than 100 tags retain 99 plus a visible **⚠ More tags omitted** marker
instead of blocking later sync pages.

The Worker updates only the properties declared in its schemas. It does not
write page body content, user-added properties, views, formulas, or rollups.

Provider indexing, rate limiting, a failed run, and the 15-minute schedule can
delay an update. Readwise and Reader remain the current source for collecting
and reviewing; Notion is the durable layer for connecting and synthesizing.

### Adapt the recipe

- Change the schedules in `src/index.ts` for a slower personal archive.
- Include Reader Feed documents by changing the Reader location scope and
  adding coverage for the larger result set.
- Add a provider field by updating response validation, the database schema,
  its transform, and the populated and missing-value tests together.

### Local testing with offline fixtures

```sh
cd workers/readwise-sync
npm install
npm run check
npm test
npm run build
```
