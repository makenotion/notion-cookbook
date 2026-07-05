# Worker sync: Raindrop.io research library

Turn your Raindrop.io bookmarks and highlights into evidence you can connect to
projects, claims, decisions, and finished work in Notion. Follow every passage
back to its source while Raindrop.io remains the place to capture and organize.

One deploy creates three related managed databases and refreshes them every
hour. The Worker is read-only and never deletes a Notion page. Raindrop.io
remains the source of truth; Notion connects what you save to the work it
informs.

## Quickstart

You need Node.js 22+, npm 10.9.2+, a Raindrop.io account, and a personal test
token. Create an app in [Raindrop.io App Management][raindrop-apps], open its
settings, and copy the **Test token**.

From the repository root, deploy the Worker, pause its schedules, and add the
token:

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
```

Use `--name raindrop-sync` only for the first deployment. After `workers.json`
identifies it, update the Worker with `ntn workers deploy`.

Preview output can contain private collection names, URLs, notes, and
highlights. Review the databases' Notion sharing settings before writing data.

Preview all three databases:

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

After the first successful run, each sync remains bound to the authenticated
Raindrop.io account. You can rotate a token for that account. Use a separate
Worker and databases for a different account.

## What you can answer

| Question                                                                                  | Start here                 | How to answer it                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Which sources and exact passages support this project, claim, or decision?                | **Raindrop.io Highlights** | Add and filter by a `Project`, `Claim`, or `Decision` relation. **Text** and **Note** hold the evidence; **Bookmark** identifies its source.                                                                 |
| Which new or scheduled sources still need processing?                                     | **Raindrop.io Bookmarks**  | Add `Review Status`. Filter **In Trash** unchecked, status empty, and either **Created** recently or **Reminder** due.                                                                                       |
| Which captured insights have not yet become a brief, decision, document, or other output? | **Raindrop.io Highlights** | Add `Synthesis Status` and optionally `Used in`. Exclude `Used` and `Archived`; when `Used in` exists, filter it to empty.                                                                                   |
| Where did this idea originate?                                                            | **Raindrop.io Highlights** | Follow **Bookmark** to **URL**, **Collection**, **Domain**, **Excerpt**, and **Note**. To show Collection in Highlights, add a rollup using **Bookmark** as the relation and **Collection** as the property. |

Each Highlight links to a **Bookmark**, and each Bookmark links to a
**Collection**. The reciprocal **Highlights** and **Bookmarks** relations let
you traverse the source trail in either direction. Project and output databases
are specific to each workspace, so you add those relations in Notion. The
Worker preserves them and each page's body content.

## Views you can build

1. **Project evidence and provenance:** Add a `Project` relation from Highlights
   to your Projects database, filter it to the current project, and show
   **Text**, **Note**, **Tags**, and **Bookmark**. Add the Collection rollup
   above, then place the linked view in your project template.
2. **Insights awaiting an output:** Add a `Synthesis Status` select with
   `To synthesize`, `Drafting`, `Used`, and `Archived`; optionally add a
   `Used in` relation. Exclude `Used` and `Archived`, require `Used in` to be
   empty when present, and group by **Tags** or `Project`.
3. **Processing queue:** Add a `Review Status` select to **Raindrop.io
   Bookmarks**. Filter **In Trash** to unchecked and `Review Status` to empty,
   then include recently **Created** bookmarks or those with **Reminder** on or
   before today. Sort **Reminder** ascending, then **Created** newest first.

## Reference

### Databases

| Database                    | One page per                       | Connected by           | Primary key      | Schedule |
| --------------------------- | ---------------------------------- | ---------------------- | ---------------- | -------- |
| **Raindrop.io Collections** | Root, child, or system collection  | Parent, Bookmarks      | `Collection Key` | Hourly   |
| **Raindrop.io Bookmarks**   | Active or trashed bookmark         | Collection, Highlights | `Bookmark Key`   | Hourly   |
| **Raindrop.io Highlights**  | Highlight returned for the account | Bookmark               | `Highlight Key`  | Hourly   |

### Included data

| Source      | Included                                                                   | Limit                           |
| ----------- | -------------------------------------------------------------------------- | ------------------------------- |
| Collections | Root and child collections, plus synthetic Unsorted and Trash targets      | 10,000 collections              |
| Bookmarks   | Active bookmarks and Trash, including metadata, notes, tags, and reminders | 10,000 per active or Trash scan |
| Highlights  | Highlights, notes, colors, tags, bookmark references, and source links     | 10,000 highlights               |

The collection-list responses do not include counts for Unsorted and Trash, so
their synthetic rows leave **Bookmark count** empty. Their **Bookmarks**
relations still contain the bookmarks observed in each system collection. This
Worker does not call the separate account-statistics endpoint.

The Worker does not copy full article text, cached page contents, or uploaded
file and media bodies. It syncs the metadata, excerpts, notes, and highlights
needed for these workflows while Raindrop.io retains the complete source.

### Update behavior

- Each hourly run scans the current provider data and updates **Last Seen**.
- Moving a bookmark to Trash updates the same page, checks **In Trash**, and
  relates it to the synthetic Trash collection. Restoring it reverses both.
- Hard-deleted or unavailable records remain as last-known Notion pages because
  the API does not provide reliable deletion tombstones.
- An older **Last Seen** value is a review signal, not proof that a record was
  deleted.
- Account-scoped provider IDs keep relations stable and prevent duplicates.
- Oversized text, URLs, and tag sets are bounded and visibly marked rather than
  blocking the scan.
- Page content and properties added in Notion are preserved.

## Adapt the sync

- Change the schedules in `src/index.ts` for a slower personal archive.
- Partition a library above the documented limits by collection rather than
  only increasing the scan cap.
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
