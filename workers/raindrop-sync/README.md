# Worker sync: Raindrop.io reading library

Bring saved links, collections, and highlights into a connected Notion research
archive. One deployment creates three related managed databases and refreshes
them every hour.

The Worker is read-only. Keep organizing and highlighting in Raindrop.io; use
Notion to connect what you save to projects, topics, reading queues, and notes.
This is deliberately an archive rather than an exact mirror: Raindrop.io does
not expose reliable deletion tombstones, so missing source records are retained
instead of risking the loss of Notion context.

## Quickstart

You need Node.js 22+, npm 10.9.2+, access to deploy Notion Workers, a
Raindrop.io account, and a personal test token. Create an app in
[Raindrop.io App Management][raindrop-apps], open its settings, and copy the
**Test token**.

From the repository root:

```sh
npm install --global ntn
cd workers/raindrop-sync
npm install
ntn login
ntn workers deploy --name raindrop-sync
ntn workers env set RAINDROP_ACCESS_TOKEN=replace-with-your-test-token
```

Preview the databases in dependency order:

```sh
ntn workers sync trigger collectionsSync --preview
ntn workers sync trigger bookmarksSync --preview
ntn workers sync trigger highlightsSync --preview
```

Previews can contain private collection names, URLs, notes, and highlights.
Protect terminal output. When the previews look right, run the initial imports:

```sh
ntn workers sync trigger collectionsSync
ntn workers sync trigger bookmarksSync
ntn workers sync trigger highlightsSync
```

The three syncs then run hourly without recurring CLI commands. Notion creates
the databases from the Worker schemas; no Notion API token is needed.

## What you can answer

| Managed database            | Questions it helps answer                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Raindrop.io Collections** | How is my source library organized? Which collections have grown, and how do they connect to current work?  |
| **Raindrop.io Bookmarks**   | What should I read next? What have I saved by project, collection, tag, type, favorite, or Trash state?     |
| **Raindrop.io Highlights**  | Which quotes and annotations are relevant to a topic or project, and which saved source did each come from? |

Bookmarks relate to Collections, and Highlights relate to Bookmarks. You can
add your own reading status, project relations, review dates, and notes without
a later sync overwriting them.

## Reference

### Synced databases and schedules

| Managed database            | Raindrop.io source                           | Schedule |
| --------------------------- | -------------------------------------------- | -------- |
| **Raindrop.io Collections** | Root, child, Unsorted, and Trash collections | Hourly   |
| **Raindrop.io Bookmarks**   | Active bookmarks followed by Trash           | Hourly   |
| **Raindrop.io Highlights**  | Account highlights                           | Hourly   |

Trigger Collections before Bookmarks and Bookmarks before Highlights on the
first import so every relation target exists. Each primary key includes the
authenticated account ID, resource type, and provider ID. Rotating a token for
the same account updates the same rows; a different account gets a separate
namespace.

#### Raindrop.io Collections

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
adds **Unsorted** (`-1`) and **Trash** (`-99`) as account-scoped relation
targets; their bookmark counts remain empty because the API does not provide
them.

#### Raindrop.io Bookmarks

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

Moving a bookmark to Trash updates the same Notion page, checks **In Trash**,
and relates it to the synthetic Trash collection. Restoring it clears the
checkbox and restores its observed collection relation.

#### Raindrop.io Highlights

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

Rich-text values are bounded to 2,000 Unicode characters. Longer values receive
an ellipsis and set **Truncated** rather than failing the page. Links above
[Notion's 2,000-character URL limit][notion-request-limits] leave **URL** empty
and set **URL Omitted**. The complete source values remain in Raindrop.io.

Tags are trimmed, whitespace-normalized, and deduplicated case-insensitively.
Commas become visually similar full-width commas (`，`) because the current
multi-select wire format uses commas as separators. Otherwise-distinct tags
that map to the same option receive a stable suffix. Records with more than 100
resulting options fail explicitly instead of silently dropping values.

### How it works

1. Each sync authenticates the token and scopes stable keys to that account.
2. Collections read both collection endpoints and add Unsorted and Trash.
3. Bookmarks scan active items in ascending creation order, then Trash, 50 at a
   time.
4. Highlights scan the account's highlights 50 at a time.
5. Every observed record is upserted and advances **Last Seen**. Unobserved
   records remain untouched with their earlier timestamp.

Raindrop.io provides page-number pagination but no change feed, snapshot cursor,
or reliable deletion tombstones. The Worker therefore never emits deletes. A
hard-deleted bookmark, collection, or highlight remains as its last-known
Notion record; an older **Last Seen** value is a review signal, not proof of
deletion. A record moved during a scan can be refreshed on the next hourly run.

Raindrop.io remains the source of truth for managed fields. The Worker owns only
the properties above and never writes page bodies, so user-added properties and
page content remain intact.

Each active-bookmark, Trash, or highlight scan stops above 10,000 records.
Partition larger libraries by collection instead of only raising the limit.
Requests share a conservative 100-per-minute pacer beneath Raindrop.io's
documented 120-per-minute limit.

Paginated state pins the authenticated account. If a token changes to a
different account mid-scan, restore the original token or reset the bookmark
and highlight sync state before importing the new account in dependency order.

### Raindrop.io access and credentials

This recipe uses one personal test token and does not implement multi-user
OAuth. The token can read private collection names, URLs, notes, Trash, and
highlights, although this Worker issues only documented `GET` requests.

Store `RAINDROP_ACCESS_TOKEN` as a Worker secret, use a dedicated Raindrop.io
app, and share the managed databases only with their intended audience. Anyone
with database access can see the synced values even when the source collection
is private. Review the [Raindrop.io API terms][raindrop-terms] before adapting
the recipe for multiple users or commercial use.

### Project structure

```text
src/
├── index.ts        — databases, schedules, and shared request pacing
├── raindrop.ts     — authenticated REST client and response validation
├── sync-state.ts   — account-pinned pagination state
├── keys.ts         — account- and resource-scoped identities
├── collections.ts  — Collection schema and transform
├── bookmarks.ts    — Bookmark schema and transform
├── highlights.ts   — Highlight schema and transform
└── format.ts       — bounded text, titles, and tag options
test.ts             — offline transforms, paging, auth, and failure tests
```

### Adapting the sync

- **Add a source field:** extend the validated API type, schema, transform,
  property table, and transform tests together.
- **Sync one collection:** replace collection ID `0` in `src/raindrop.ts`, then
  decide whether nested collections and Trash history remain in scope.
- **Partition a large library:** register one managed database and incremental
  scan per collection so each capability stays below 10,000 records.
- **Add retention:** require a reviewed user action or provider-backed deletion
  signal; never translate one missing page-number scan into deletion.
- **Serve multiple users:** implement Raindrop.io OAuth and refresh-token
  handling while retaining account-scoped keys.

### Local testing

Offline checks use mocked HTTP responses and need no Raindrop.io credentials.
From the repository root:

```sh
cd workers/raindrop-sync
npm install
npm run check
npm test
npm run build
```

After deployment, inspect a live read without writing to Notion:

```sh
ntn workers sync trigger bookmarksSync --preview
```

## Learn more

- [Raindrop.io API overview and rate limits][raindrop-overview]
- [Authentication and personal test tokens][raindrop-token]
- [Authenticated user identity][raindrop-user]
- [Collection methods][raindrop-collections]
- [Bookmark fields][raindrop-fields]
- [Paginated bookmark reads][raindrop-bookmarks]
- [Highlights][raindrop-highlights]
- [Notion Workers documentation](https://developers.notion.com/workers/get-started/overview)
- [Contributing guide](../../CONTRIBUTING.md)

[notion-request-limits]: https://developers.notion.com/reference/request-limits
[raindrop-apps]: https://app.raindrop.io/settings/integrations
[raindrop-bookmarks]: https://developer.raindrop.io/v1/raindrops/multiple
[raindrop-collections]: https://developer.raindrop.io/v1/collections/methods
[raindrop-fields]: https://developer.raindrop.io/v1/raindrops
[raindrop-highlights]: https://developer.raindrop.io/v1/highlights
[raindrop-overview]: https://developer.raindrop.io/
[raindrop-terms]: https://developer.raindrop.io/terms
[raindrop-token]: https://developer.raindrop.io/v1/authentication/token
[raindrop-user]: https://developer.raindrop.io/v1/user/authenticated
