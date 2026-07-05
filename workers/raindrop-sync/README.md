# Worker sync: Raindrop.io reading library

Turn your Raindrop.io bookmarks and highlights into a connected Notion
research library. Use it to review what you save, connect sources and evidence
to projects, and preserve the notes you develop in Notion.

One deploy creates three related managed databases and refreshes them every
hour. The Worker is read-only and never deletes a Notion page. Raindrop.io
remains the place to collect and organize; Notion becomes the project and
knowledge layer.

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

| Managed database            | Questions it helps answer                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Raindrop.io Collections** | How is my library organized? Which collections contain the most saved links?                                 |
| **Raindrop.io Bookmarks**   | What deserves review? What have I favorited, tagged, broken, or moved to Trash?                              |
| **Raindrop.io Highlights**  | Which quotes and annotations support this project? Which bookmark and collection supplied the original idea? |

Bookmarks relate to Collections, and Highlights relate to Bookmarks. The
Worker preserves properties you add in Notion and each page's body content.

## Views you can build

- **Inbox to review:** Add a `Review Status` select to **Raindrop.io
  Bookmarks**. Filter for an empty status with **In Trash** unchecked, then sort
  **Updated** newest first. Mark links `Reviewed` as you process them.
- **Library cleanup:** In **Raindrop.io Bookmarks**, filter where **Broken** or
  **In Trash** is checked. Add older **Last Seen** records when you want to
  review links that may no longer be visible upstream.
- **Project evidence:** Add a `Project` relation to **Raindrop.io Highlights**
  and place a linked view on each project. Add the relation to Bookmarks too if
  you also want a project reading list.

## Reference

### Databases

| Database                    | One page per                       | Relation          | Primary key      | Schedule |
| --------------------------- | ---------------------------------- | ----------------- | ---------------- | -------- |
| **Raindrop.io Collections** | Root, child, or system collection  | Parent collection | `Collection Key` | Hourly   |
| **Raindrop.io Bookmarks**   | Active or trashed bookmark         | Collection        | `Bookmark Key`   | Hourly   |
| **Raindrop.io Highlights**  | Highlight returned for the account | Bookmark          | `Highlight Key`  | Hourly   |

### Included data

| Source      | Included                                                               | Limit                           |
| ----------- | ---------------------------------------------------------------------- | ------------------------------- |
| Collections | Root and child collections, plus synthetic Unsorted and Trash targets  | 10,000 collections              |
| Bookmarks   | All active bookmarks followed by Trash                                 | 10,000 per active or Trash scan |
| Highlights  | Highlights, notes, colors, tags, bookmark references, and source links | 10,000 highlights               |

The collection-list responses do not include counts for Unsorted and Trash, so
their synthetic rows leave **Bookmarks** empty. This Worker does not call the
separate account-statistics endpoint.

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
- [Highlights][raindrop-highlights]
- [Notion Workers sync guide](https://developers.notion.com/workers/guides/syncs)
- [Contributing guide](../../CONTRIBUTING.md)

[raindrop-apps]: https://app.raindrop.io/settings/integrations
[raindrop-bookmarks]: https://developer.raindrop.io/v1/raindrops/multiple
[raindrop-highlights]: https://developer.raindrop.io/v1/highlights
[raindrop-overview]: https://developer.raindrop.io/
