# Worker sync: Raindrop.io research library

Turn your Raindrop.io bookmarks and highlights into source material for
projects, decisions, briefs, and documents in Notion. Each highlight stays
connected to its original bookmark and collection, and shared items show who
saved them when that information is available.

Deploy once to create three related managed databases for collections,
bookmarks, and highlights, with each sync scheduled hourly. The Worker only
reads from Raindrop.io and updates Notion; it never changes your Raindrop.io
library or deletes Notion pages. Raindrop.io remains your capture library,
while Notion is where saved material connects to active work.

## Quickstart

You need Node.js 22+, npm 10.9.2+, a Raindrop.io account, and a personal test
token. Create an app in [Raindrop.io App Management][raindrop-apps], open its
settings, and copy the **Test token**. Use it to retrieve the account ID:

```sh
curl https://api.raindrop.io/rest/v1/user \
  --header "Authorization: Bearer replace-with-your-test-token"
```

Copy `user._id` from the response.

From the repository root, deploy the Worker, pause its schedules, and add the
account configuration:

```sh
npm install --global ntn@latest
cd workers/raindrop-sync
npm install
ntn login
ntn workers deploy --name raindrop-sync
ntn workers sync pause collectionsSync
ntn workers sync pause bookmarksSync
ntn workers sync pause highlightsSync
ntn workers env set RAINDROP_ACCESS_TOKEN=replace-with-your-test-token
ntn workers env set RAINDROP_ACCOUNT_ID=replace-with-your-user-id
```

Use `--name raindrop-sync` only for the first deployment. After `workers.json`
identifies it, update the Worker with `ntn workers deploy`.

The token may expose owned and shared collections. Raindrop.io ownership,
access roles, and contributor names are copied as metadata but are not enforced
by Notion. Review the databases' sharing settings before importing.

Preview the first output batch from each sync:

```sh
ntn workers sync trigger collectionsSync --preview
ntn workers sync trigger bookmarksSync --preview
ntn workers sync trigger highlightsSync --preview
```

Import Collections first so Bookmark relations have targets:

```sh
ntn workers sync trigger collectionsSync
ntn workers sync status collectionsSync
```

When Collections succeeds, press Ctrl-C and import Bookmarks:

```sh
ntn workers sync trigger bookmarksSync
ntn workers sync status bookmarksSync
```

When Bookmarks succeeds, press Ctrl-C and import Highlights:

```sh
ntn workers sync trigger highlightsSync
ntn workers sync status highlightsSync
```

When Highlights succeeds, press Ctrl-C, review the databases, and resume the
hourly schedules:

```sh
ntn workers sync resume collectionsSync
ntn workers sync resume bookmarksSync
ntn workers sync resume highlightsSync
```

You do not need to create the databases or provide a Notion API token.

`RAINDROP_ACCOUNT_ID` binds the entire deployment to one Raindrop.io account.
You can rotate a token for that account. Use a separate Worker and databases
for a different account.

## What you can answer

| Question                                                                                  | Start here                 | How to answer it                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which sources and exact passages support this project, claim, or decision?                | **Raindrop.io Highlights** | Add and filter by a `Project`, `Claim`, or `Decision` relation. **Text** is the synced passage, **Note** its annotation, and **Bookmark** its source. Check **Truncated** before quoting.            |
| Which new or scheduled sources still need processing?                                     | **Raindrop.io Bookmarks**  | Add `Review Status`. Filter **In Trash** unchecked, status empty, and either **Created** recently or **Reminder** due.                                                                               |
| Which captured insights have not yet become a brief, decision, document, or other output? | **Raindrop.io Highlights** | Add `Synthesis Status` and optionally `Used in`. Exclude `Used` and `Archived`; when `Used in` exists, filter it to empty.                                                                           |
| Where did this idea originate?                                                            | **Raindrop.io Highlights** | Follow **Bookmark** to **Raindrop contributor**, **URL**, **Collection**, **Domain**, **Excerpt**, and **Note**. Add a rollup using **Bookmark** as the relation and **Collection** as the property. |

For imported records, each Highlight links to a **Bookmark**, and each Bookmark
links to a **Collection**. The reciprocal relations let you traverse the source
trail in either direction. Project and output databases are specific to each
workspace, so you add those relations in Notion. The Worker preserves those
properties and each page's body content.

**Raindrop contributor** identifies who created the bookmark in Raindrop when
the API returns that context. A blank value does not identify the contributor.

## Views you can build

1. **Project evidence and provenance:** Add a `Project` relation from Highlights
   to your Projects database, filter it to the current project, and show
   **Text**, **Note**, **Tags**, **Bookmark**, and **Truncated**. Add the
   Collection rollup above, then place the linked view in your project template.
2. **Insights awaiting an output:** Add a `Synthesis Status` select with
   `To synthesize`, `Drafting`, `Used`, and `Archived`; optionally add a
   `Used in` relation. Exclude `Used` and `Archived`, require `Used in` to be
   empty when present, and group by **Tags** or `Project`.
3. **Processing queue:** Add a `Review Status` select to **Raindrop.io
   Bookmarks**. Filter **In Trash** to unchecked and `Review Status` to empty,
   then include recently **Created** bookmarks or those with **Reminder** on or
   before today. For a current-only queue, require **Last Seen** within the past
   day. Sort **Reminder** ascending, then **Created** newest first. Reminder data
   requires Raindrop Premium; `Review Status` remains the durable state.

## Reference

### Databases

| Database                    | One page per                       | Connected by           | Primary key      | Schedule |
| --------------------------- | ---------------------------------- | ---------------------- | ---------------- | -------- |
| **Raindrop.io Collections** | Root, child, or system collection  | Parent, Bookmarks      | `Collection Key` | Hourly   |
| **Raindrop.io Bookmarks**   | Active or trashed bookmark         | Collection, Highlights | `Bookmark Key`   | Hourly   |
| **Raindrop.io Highlights**  | Highlight returned for the account | Bookmark               | `Highlight Key`  | Hourly   |

### Included data

| Source      | Included                                                                                       | Recipe hard stop                |
| ----------- | ---------------------------------------------------------------------------------------------- | ------------------------------- |
| Collections | Root and child collections, access metadata, plus synthetic Unsorted and Trash targets         | 1,000 collections               |
| Bookmarks   | Active bookmarks and Trash, including source metadata, contributor, notes, tags, and reminders | 10,000 per active or Trash scan |
| Highlights  | Highlights, notes, colors, tags, bookmark references, and source links                         | 10,000 highlights               |

Collections fit in one output batch; Bookmark and Highlight executions emit at
most 150 changes. Tests keep the largest envelopes below the Worker output
limit. A scan that exceeds a hard stop fails and must be partitioned.

The collection-list responses do not include counts for Unsorted and Trash, so
their synthetic rows leave **Bookmark count** empty. Their **Bookmarks**
relations still contain the bookmarks observed in each system collection. This
Worker does not call the separate account-statistics endpoint.

If a shared collection's parent is not visible to the token, **Parent** remains
empty while **Parent ID** and **Parent unavailable** preserve that context.

The Worker does not copy full article text, cached page contents, or uploaded
file and media bodies. Those remain in Raindrop.io; Notion receives the source
metadata, excerpts, notes, and highlights used by these workflows.

### Update behavior

- Each sync is scheduled hourly. Records observed during its paginated scan get
  a new **Last Seen** value.
- A bounded drift guard detects common Bookmark and Highlight page shifts and
  restarts each phase once. Continued changes complete best-effort without
  deleting pages; later runs may fill omissions.
- When a bookmark is observed in Trash, the same page is checked **In Trash**
  and related to Trash. A later observation outside Trash reverses both.
- The Worker does not infer deletion from absence. Records no longer returned
  remain as last-known Notion pages.
- An older **Last Seen** value is a review signal, not proof that a record was
  deleted.
- Account-scoped provider IDs upsert the same Raindrop record to the same Notion
  page and keep relation keys stable.
- Oversized text, URLs, and tag sets are bounded and visibly marked rather than
  blocking the scan.
- Page content and user-created properties are preserved. Synced properties are
  refreshed from Raindrop.io.

## Adapt the sync

- Change the schedules in `src/index.ts` for a slower personal archive.
- For a library above this recipe's hard stops, implement collection-scoped
  partitioning rather than only increasing the constants.
- Add a provider field by updating response validation, the database schema,
  its transform, and tests together.

## Local verification

The checks use offline fixtures and require no Raindrop.io or Notion
credentials:

```sh
cd workers/raindrop-sync
npm install
npm run check
npm test
npm run build
```

## Learn more

- [Raindrop.io API overview][raindrop-overview]
- [Paginated bookmark reads][raindrop-bookmarks]
- [Reminders][raindrop-reminders]
- [Highlights][raindrop-highlights]
- [Notion Workers sync guide](https://developers.notion.com/workers/guides/syncs)
- [Contributing guide](../../CONTRIBUTING.md)

[raindrop-apps]: https://app.raindrop.io/settings/integrations
[raindrop-bookmarks]: https://developer.raindrop.io/v1/raindrops/multiple
[raindrop-highlights]: https://developer.raindrop.io/v1/highlights
[raindrop-overview]: https://developer.raindrop.io/
[raindrop-reminders]: https://help.raindrop.io/reminders
