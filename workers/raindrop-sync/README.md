# Worker sync: Raindrop.io reading library

Turn saved links and highlights into a connected, non-destructive Notion
research archive. This Worker creates managed databases for Raindrop.io
collections, bookmarks, and highlights, then scans the account every hour.

The sync is read-only. Keep organizing and highlighting in Raindrop.io; use
Notion to connect what you save to projects, topics, reading queues, and notes.
Account-scoped source keys update the same pages on every run. User-added Notion
properties and page bodies remain untouched, even when a source record later
disappears from Raindrop.io.

This is deliberately an archive, not an exact mirror. Raindrop.io does not
provide reliable tombstones for hard-deleted bookmarks, deleted collections, or
removed highlights, so the Worker never automatically deletes managed pages.

## Quickstart

You need:

- Node.js 22 or newer and npm 10.9.2 or newer;
- access to deploy Notion Workers;
- a Raindrop.io account; and
- a Raindrop.io test token for your own account.

Create an app in [Raindrop.io App Management][raindrop-apps], open its
settings, and copy the **Test token**. Raindrop.io recommends this simpler token
when an integration only accesses its creator's account. This recipe uses one
personal account token at a time; it does not implement OAuth for other users.

From the repository root:

```sh
npm install --global ntn@latest
cd workers/raindrop-sync
npm install
npm run check
npm test
ntn login
ntn workers deploy --name raindrop-sync
```

Store the token as a Worker secret. Do not add it to source control.

```sh
ntn workers env set RAINDROP_ACCESS_TOKEN=replace-with-your-test-token
```

Preview each database in dependency order:

```sh
ntn workers sync trigger collectionsSync --preview
ntn workers sync trigger bookmarksSync --preview
ntn workers sync trigger highlightsSync --preview
```

Previews can print private collection names, bookmark titles, URLs, notes, and
highlights. Protect terminal output. When the previews look right, run the
initial imports:

```sh
ntn workers sync trigger collectionsSync
ntn workers sync trigger bookmarksSync
ntn workers sync trigger highlightsSync
ntn workers sync status
```

The three syncs then scan hourly without a recurring CLI command. The Worker
does not need a Notion API token.

## What you get

| Managed database            | What it is useful for                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Raindrop.io Collections** | Browse the observed source hierarchy and relate collections to other Notion work.                      |
| **Raindrop.io Bookmarks**   | Build reading queues, project libraries, and views by collection, tag, type, favorite, or Trash state. |
| **Raindrop.io Highlights**  | Review quotes and annotations independently while retaining a relation to the source bookmark.         |

The Worker creates two-way relations from Bookmarks to Collections and from
Highlights to Bookmarks. Trigger Collections before Bookmarks, and Bookmarks
before Highlights, on the first import so every relation target already exists.

Every primary key includes the authenticated Raindrop account ID, resource type,
and raw provider ID. For example, bookmark `42` in account `321` uses
`raindrop:321:bookmark:42`. Rotating a token for the same account updates the
same rows. A token for a different account creates a separate set of rows and
cannot overwrite the earlier account's archive.

### Collections

| Notion property     | Raindrop.io field or meaning              | Type                   |
| ------------------- | ----------------------------------------- | ---------------------- |
| Name                | `title`                                   | title                  |
| Parent              | Account-scoped `parent.$id`               | self-relation          |
| Subcollections      | Reciprocal of Parent                      | reciprocal relation    |
| Bookmarks           | `count`                                   | number                 |
| Public              | `public`                                  | checkbox               |
| Created             | `created`                                 | date                   |
| Updated             | `lastUpdate`                              | date                   |
| Last Seen           | When the Worker most recently observed it | date                   |
| Collection ID       | Raw `_id`                                 | rich text              |
| Raindrop Account ID | Authenticated user `_id`                  | rich text              |
| Collection Key      | Account-scoped source identity            | rich text, primary key |
| Synced Bookmarks    | Reciprocal of each bookmark's Collection  | reciprocal relation    |

Raindrop.io omits system collections from its collection endpoints. The Worker
adds account-scoped **Unsorted** (`-1`) and **Trash** (`-99`) relation targets.
Their bookmark counts are left blank because the collection responses do not
provide them.

### Bookmarks

| Notion property     | Raindrop.io field or meaning                 | Type                    |
| ------------------- | -------------------------------------------- | ----------------------- |
| Title               | `title`, with domain or URL as a fallback    | title                   |
| URL                 | `link`                                       | URL                     |
| URL Omitted         | `link` exceeded Notion's URL limit           | checkbox                |
| Collection          | Account-scoped `collection.$id` relation     | relation to Collections |
| Tags                | `tags`                                       | multi-select            |
| Type                | `type`                                       | select                  |
| Domain              | `domain`                                     | rich text               |
| Favorite            | `important`                                  | checkbox                |
| Broken              | `broken`                                     | checkbox                |
| In Trash            | Whether this scan observed the item in `-99` | checkbox                |
| Note                | `note`                                       | rich text               |
| Excerpt             | `excerpt`                                    | rich text               |
| Truncated           | Title, Note, or Excerpt exceeded its limit   | checkbox                |
| Highlights          | Number of embedded highlights                | number                  |
| Created             | `created`                                    | date                    |
| Updated             | `lastUpdate`                                 | date                    |
| Last Seen           | When the Worker most recently observed it    | date                    |
| Raindrop ID         | Raw `_id`                                    | rich text               |
| Raindrop Account ID | Authenticated user `_id`                     | rich text               |
| Bookmark Key        | Account-scoped source identity               | rich text, primary key  |
| Synced Highlights   | Reciprocal of each highlight's Bookmark      | reciprocal relation     |

Each bookmark scan reads active items and then Trash. Moving a bookmark to
Trash updates the same Notion page to **In Trash = checked** and relates it to
the synthetic Trash collection. Restoring it updates that page to
**In Trash = unchecked** and restores its observed collection relation.

### Highlights

| Notion property     | Raindrop.io field or meaning              | Type                   |
| ------------------- | ----------------------------------------- | ---------------------- |
| Highlight           | Compact single-line excerpt of `text`     | title                  |
| Text                | `text`                                    | rich text              |
| Note                | `note`                                    | rich text              |
| Bookmark            | Account-scoped `raindropRef` relation     | relation to Bookmarks  |
| Bookmark title      | `title`                                   | rich text              |
| URL                 | `link`                                    | URL                    |
| URL Omitted         | `link` exceeded Notion's URL limit        | checkbox               |
| Color               | Documented `color` enum                   | select                 |
| Tags                | `tags`                                    | multi-select           |
| Truncated           | Text or Note exceeded the property limit  | checkbox               |
| Created             | `created`                                 | date                   |
| Last Seen           | When the Worker most recently observed it | date                   |
| Highlight ID        | Raw `_id`                                 | rich text              |
| Raindrop Account ID | Authenticated user `_id`                  | rich text              |
| Highlight Key       | Account-scoped source identity            | rich text, primary key |

Notion rich-text properties are bounded to 2,000 Unicode characters in this
reference recipe. When a source Note, Excerpt, highlight Text, or highlight Note
is longer, the Worker adds an ellipsis and checks **Truncated** instead of
failing the entire library. The complete values remain in Raindrop.io while the
source record exists. Page bodies are deliberately not managed, so you can
write longer summaries and project-specific notes there without a later scan
overwriting them.

[Notion URL properties accept at most 2,000 characters][notion-request-limits].
When a bookmark or highlight link is longer, the Worker leaves **URL** empty and
checks **URL Omitted** instead of failing that page and blocking the rest of the
scan. The complete link remains in Raindrop.io.

Source timestamps are normalized to UTC before they are written to Notion date
properties.

Tag names are trimmed, whitespace-normalized, and deduplicated
case-insensitively. Because the Worker multi-select wire format uses commas as
separators, a comma inside one Raindrop.io tag becomes a visually similar
full-width comma (`，`). If otherwise-distinct tags map to the same Notion
option, the Worker adds a stable suffix to preserve both. More than 100
resulting options on one record fails the page instead of silently dropping
values.

## Archive and refresh semantics

Raindrop.io's documented REST API provides stable IDs and page-number
pagination, but not a change feed, snapshot cursor, or reliable deletion feed.
Each capability therefore uses `mode: "incremental"` for a complete,
non-destructive scan:

1. The Worker fetches the authenticated user's stable account ID.
2. Collections read both collection endpoints and add Unsorted and Trash.
3. Bookmarks read all active items in ascending creation order, then all Trash
   items, 50 at a time.
4. Highlights read the global highlights endpoint, 50 at a time.
5. Every observed record is upserted and advances **Last Seen**. Unobserved
   records are left untouched with their earlier timestamp.

This means:

- A moved or restored Trash item is updated explicitly through **In Trash**.
- A hard-deleted bookmark remains as its last-known Notion record and retains
  its earlier **Last Seen** value.
- A deleted collection remains as its last-known Notion record and retains its
  earlier **Last Seen** value.
- A removed or hard-deleted highlight remains as its last-known Notion record
  and retains its earlier **Last Seen** value.
- The API does not provide enough information to label those last three cases
  as deleted reliably. Treat them as archive records, not confirmed live data.

This non-destructive behavior is intentional. With page-number pagination, a
save or deletion during a long scan can move another item across a page
boundary. A missed item is refreshed on a later scan, but its Notion page and
user-owned annotations are never deleted merely because one scan did not see
it.

The reference Worker stops above 10,000 active Bookmarks, 10,000 Trash
Bookmarks, or 10,000 Highlights instead of accepting an unbounded run.
Partition larger libraries by collection. Collection responses are also capped
at 10,000 records.

Each execution captures one token and uses it for both the authenticated-user
lookup and its following data request. Every paginated continuation also stores
the authenticated account ID. If the token changes to another account during a
scan, the capability fails before reading the next data page. Restore the
original token or reset that capability's state before intentionally continuing
with the other account.

All requests share a Worker pacer set to 100 requests per minute, below
Raindrop.io's documented limit of 120 authenticated requests per minute. HTTP
429 responses become Worker rate-limit signals. Requests time out after 30
seconds, reject redirects, and cap decoded response bodies at 10 MiB.

## Source of truth and editing

This is a one-way refresh and archive. Change managed fields, collection
membership, tags, notes, and highlights in Raindrop.io. Observed records update
on the next complete scan.

In Notion, you can safely add properties such as:

- Reading status
- Project or topic relations
- Why it matters
- Review date
- Shared with

The Worker schema owns only the properties listed above and does not write page
bodies. Because it never emits deletes, source disappearance does not remove a
managed page or its user-added values. Use **Last Seen** to find records that
have not been observed recently, then verify them in Raindrop.io before taking
destructive action. Absence from one scan is not proof of deletion.

## Privacy and access

The token can read private URLs, notes, tags, collection names, Trash, and
highlights. The Worker sends those selected fields to managed Notion databases.
Anyone who can access those databases can see the synced values, even when the
original Raindrop.io collection is private or the bookmark is in Trash.

- Use a dedicated Raindrop.io app and its test token; do not reuse credentials
  from another integration.
- Share the managed databases only with the intended audience.
- Never commit `.env`, tokens, preview output, or generated `workers.json`
  state.
- Review the [Raindrop.io API terms][raindrop-terms] before adapting this into a
  multi-user or commercial product.

Although a Raindrop.io bearer token can authorize writes, this Worker only
issues documented `GET` requests.

## Project structure

```text
src/
├── index.ts        — registers databases, schedules, and the shared pacer
├── raindrop.ts     — authenticated REST client and response validation
├── sync-state.ts   — account-pinned active, Trash, and highlight scan state
├── keys.ts         — account- and resource-scoped stable identities
├── collections.ts  — Collections schema and transform
├── bookmarks.ts    — Bookmarks schema and transform
├── highlights.ts   — Highlights schema and transform
└── format.ts       — labels, titles, and disclosed text bounds
test.ts             — offline transforms, paging, auth, and failure tests
```

## Adapt the recipe

Common extensions:

1. **Sync one collection.** Replace collection ID `0` in `src/raindrop.ts` with
   a configured collection ID and document whether nested collections are
   included. Decide separately whether its Trash history is still required.
2. **Partition a large library.** Declare one managed database and incremental
   full scan per collection so each capability remains below 10,000 records.
3. **Add an explicit retention workflow.** If stale archive records must be
   removed, require a reviewed user action or a provider-backed deletion signal;
   do not translate one missing page-number scan into deletion.
4. **Change the cadence.** Adjust the three `schedule` values in `src/index.ts`.
   Keep complete scans affordable for the library size.
5. **Add source fields.** Extend the validated API type, its schema, its
   transform, and the property table in this README together.
6. **Serve multiple users.** Replace the personal test-token setup with a
   reviewed OAuth design using Raindrop.io's authorization and refresh-token
   flow. Keep account-scoped keys; do not share one user's token between
   deployments.

## Verify locally

The checks use fixtures and mocked HTTP responses; they do not call
Raindrop.io or require credentials.

```sh
npm install
npm run check
npm test
npm run build
```

To inspect a live response without writing managed databases after deployment:

```sh
ntn workers sync trigger bookmarksSync --preview
```

## Troubleshooting

### The Worker reports an invalid token

Open the app in [Raindrop.io App Management][raindrop-apps], replace its test
token in Worker secrets, and preview again:

```sh
ntn workers env set RAINDROP_ACCESS_TOKEN=replace-with-your-test-token
ntn workers sync trigger collectionsSync --preview
```

### The account changed during a scan

If the token was changed accidentally, restore the original account's token. To
intentionally continue with a different account, reset only the in-flight
paginated capabilities, then trigger the imports in dependency order:

```sh
ntn workers sync state reset bookmarksSync
ntn workers sync state reset highlightsSync
ntn workers sync trigger collectionsSync
ntn workers sync trigger bookmarksSync
ntn workers sync trigger highlightsSync
```

The previous account's rows remain as an archive. New rows use a different
account namespace.

### Relations are empty

Run the initial imports in dependency order: Collections, Bookmarks, then
Highlights. The hourly scans keep using the same account-scoped keys.

### A deleted source record still appears

This is expected archive behavior. Raindrop.io does not expose reliable
tombstones for hard-deleted bookmarks, deleted collections, or removed
highlights. The Worker preserves last-known rows so an ambiguous absence cannot
destroy Notion notes or user-added properties.

### A moved bookmark has the wrong Trash state temporarily

Check that the latest bookmark scan completed. Page-number APIs cannot freeze a
changing library; the next complete active-and-Trash scan refreshes the same
account-scoped bookmark key.

### The sync exceeds 10,000 records

Partition it by collection. Do not only raise the limit: larger full scans
increase runtime, rate-limit pressure, and the window for page movement.

## API references

- [Notion request limits][notion-request-limits]
- [Raindrop.io API overview and rate limits][raindrop-overview]
- [Authentication and personal test tokens][raindrop-token]
- [Authenticated user identity][raindrop-user]
- [Collection methods][raindrop-collections]
- [Bookmark fields][raindrop-fields]
- [Paginated bookmark reads][raindrop-bookmarks]
- [Highlights][raindrop-highlights]

[raindrop-apps]: https://app.raindrop.io/settings/integrations
[notion-request-limits]: https://developers.notion.com/reference/request-limits
[raindrop-bookmarks]: https://developer.raindrop.io/v1/raindrops/multiple
[raindrop-collections]: https://developer.raindrop.io/v1/collections/methods
[raindrop-fields]: https://developer.raindrop.io/v1/raindrops
[raindrop-highlights]: https://developer.raindrop.io/v1/highlights
[raindrop-overview]: https://developer.raindrop.io/
[raindrop-terms]: https://developer.raindrop.io/terms
[raindrop-token]: https://developer.raindrop.io/v1/authentication/token
[raindrop-user]: https://developer.raindrop.io/v1/user/authenticated
