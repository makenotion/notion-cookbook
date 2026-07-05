# Worker sync: Readwise and Reader

Turn your Reader library and Readwise highlights into a connected Notion
research archive. Use it to finish what you save, recover ideas worth
developing, and bring evidence into the projects where you need it.

One deploy creates two related managed databases and refreshes them every 15
minutes. The Worker is read-only: it never changes Reader or Readwise, never
deletes a Notion page, and does not require a Notion API token.

## Quickstart

You need Node.js 22+, npm 10.9.2+, a Readwise account with API access, and a
personal [Readwise access token](https://readwise.io/access_token).

From the repository root, deploy the Worker, pause its schedules, and add the
token:

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

Preview output can contain private reading activity, notes, and highlights.
Review the databases' Notion sharing settings before writing data.

Preview both databases without writing to Notion:

```sh
ntn workers sync trigger sourcesSync --preview
ntn workers sync trigger highlightsSync --preview
```

Import Sources first so every Highlight can link to its Source:

```sh
ntn workers sync trigger sourcesSync
ntn workers sync status sourcesSync
```

When Sources succeeds, press Ctrl-C and import Highlights:

```sh
ntn workers sync trigger highlightsSync
ntn workers sync status highlightsSync
```

When Highlights succeeds, press Ctrl-C, review both databases, and resume the
schedules:

```sh
ntn workers sync resume sourcesSync
ntn workers sync resume highlightsSync
```

One deployment is bound to one Readwise access token. If the token changes, the
Worker stops before reading or writing. Restore the original token or use a
separate deployment and databases for the new one.

## What you can answer

| Managed database       | Questions it helps answer                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Reading Sources**    | What have I saved but not finished? Which authors, sites, and tags recur? What belongs in this project's reading list? |
| **Reading Highlights** | What have I annotated or favorited? Which evidence supports this project? Which ideas are ready to synthesize?         |

Reader documents and non-Reader sources with highlights from Kindle, Apple
Books, Instapaper, and other Readwise connections share one Source database.
Every Highlight links to its Source, and Reader-backed records are unified
instead of duplicated.

## Views you can build

- **Unfinished Inbox:** In **Reading Sources**, filter **Location** to
  `Inbox`, **Reading Progress** to less than `100%`, and **Removed upstream** to
  unchecked. Sort **Saved** newest first.
- **Ideas to synthesize:** Add a `Synthesis Status` select to **Reading
  Highlights** and mark promising notes or favorites as `To Synthesize`. Filter
  to that status with **Removed upstream** unchecked, then group by **Tags** or
  **Source**.
- **Project evidence:** Add a `Project` relation to **Reading Highlights** and
  filter **Removed upstream** to unchecked. Place a linked view on each project;
  add the relation to Sources too if you also want a project reading list.

The Worker updates provider-owned fields while preserving properties you add
in Notion and each page's body content.

## Reference

### Databases

| Database               | One page per                                         | Primary key     | Schedule     |
| ---------------------- | ---------------------------------------------------- | --------------- | ------------ |
| **Reading Sources**    | Reader document or non-Reader source with highlights | `Source Key`    | Every 15 min |
| **Reading Highlights** | Readwise highlight                                   | `Highlight Key` | Every 15 min |

### Included data

| Source   | Included                                                                                 | Excluded                              |
| -------- | ---------------------------------------------------------------------------------------- | ------------------------------------- |
| Reader   | Top-level saved documents, metadata, progress, and queue location                        | Feed and child documents              |
| Readwise | Sources with highlights, highlights, notes, tags, favorites, and supplemental highlights | Non-Reader sources without highlights |

Reader Feed items with highlights can still appear through Highlight Export.

### Update behavior

- The first run backfills available records; later runs are incremental.
- After the backfill, explicit Highlight and non-Reader Source removals set
  **Removed upstream**. Reader-backed Source removals leave the unified Source
  active.
- The Worker never deletes Notion pages.
- Records missing from an API response remain unchanged, so stale rows can
  remain.
- Page content and properties added in Notion are preserved.

## Adapt the sync

- Change the schedules in `src/index.ts` for a slower personal archive.
- Include Reader Feed documents by changing the Feed exclusion in
  `readerDocumentToChange()` and updating its tests.
- Add a provider field by updating response validation, the database schema,
  its transform, and tests together.

## Local verification

The checks use offline fixtures and require no Readwise or Notion credentials:

```sh
cd workers/readwise-sync
npm install
npm run check
npm test
npm run build
```

## Learn more

- [Notion Workers overview](https://developers.notion.com/workers/get-started/overview)
- [Notion Workers sync guide](https://developers.notion.com/workers/guides/syncs)
- [Readwise Reader API](https://readwise.io/reader_api)
- [Readwise API](https://readwise.io/api_deets)
- [Contributing guide](../../CONTRIBUTING.md)
