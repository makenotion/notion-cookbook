# Worker Sync: Linear

A Notion worker that one-way syncs issues from a [Linear](https://linear.app) workspace into a managed Notion database. After deploy, Notion will hold a row per Linear issue, refreshed every 5 minutes via Linear's GraphQL API.

## Prerequisites

- A Notion workspace where you can install workers.
- A Linear workspace and a [personal API key](https://linear.app/settings/account/security) (Settings → Security & access → New API key).
- Node.js ≥ 22 and the [`ntn` CLI](https://developers.notion.com/workers/get-started/quickstart) installed.

## Step 1 — Clone and install

```zsh
git clone https://github.com/makenotion/notion-cookbook.git
cd notion-cookbook/examples/workers/syncs/linear
npm install
ntn login
```

## Step 2 — Store your Linear API key

```zsh
ntn workers env set LINEAR_API_KEY=<your-key>
```

Linear personal API keys go in the `Authorization` header **without** a `Bearer` prefix — `linear.ts` handles this.

## Step 3 — Deploy

```zsh
ntn workers deploy --name linear-sync
```

The deploy creates a managed database titled **Linear Issues** in your workspace. You can move it into any page after the first sync runs.

## Step 4 — Run the first backfill

The delta sync runs every 5 minutes, but it only catches issues updated _after_ it first runs. To populate the database from your existing Linear workspace, trigger the backfill once:

```zsh
ntn workers sync trigger issuesBackfill
```

Watch its progress:

```zsh
ntn workers sync status
```

When it finishes, open the **Linear Issues** database — every issue in your workspace should now have a row.

## Step 5 — Verify the delta sync

Create a new issue in Linear (or edit an existing one). Within 5 minutes:

```zsh
ntn workers sync trigger issuesDelta   # or just wait for the schedule
```

The row appears (or its fields update) in Notion.

## How the code is organized

- `src/index.ts` — Worker entry. Declares the managed database, the shared rate-limit pacer, and both syncs (`issuesBackfill` and `issuesDelta`).
- `src/linear.ts` — GraphQL helpers. `fetchAllIssuesPage` (no filter, used by backfill) and `fetchIssuesUpdatedSince` (filtered by `updatedAt`, used by delta).
- `src/types.ts` — `LinearIssue` field shape and the `IssuePage` pagination wrapper.

The delta sync's state shape is `{ since, after, maxSeen }` — `since` is the `updatedAt` watermark, `after` is the within-cycle page cursor, and `maxSeen` is the running maximum across pages of the current cycle. The 15-second consistency buffer (`CONSISTENCY_BUFFER_MS`) prevents the cursor from running ahead of Linear's eventually-consistent index.

## Customizing

- **Add a property** — extend `ISSUE_FIELDS` in `linear.ts`, the `LinearIssue` type in `types.ts`, the schema in `index.ts`, and `toUpsert` in `index.ts`.
- **Change the sync frequency** — adjust `schedule: "5m"` on `issuesDelta` (allowed values: `5m`, `15m`, `1h`, `1d`).
- **Sync only one team** — add a `team: { id: { eq: "<team-id>" } }` filter to the GraphQL query in `linear.ts`.

## Troubleshooting

- **"LINEAR_API_KEY is not set"** — run `ntn workers env set LINEAR_API_KEY=...` and redeploy.
- **`401 Unauthorized` from Linear** — your key was revoked or copied with a leading/trailing space. Generate a new one.
- **Issues stop appearing after a while** — the delta cursor may have run ahead. Run `ntn workers sync state reset issuesDelta` then `ntn workers sync trigger issuesBackfill` to re-reconcile.
- **A row was deleted in Linear but is still in Notion** — the delta sync doesn't propagate hard-deletes. Trigger `issuesBackfill` to clean up.

## Learn more

- [Notion Workers documentation](https://developers.notion.com/workers/get-started/overview)
- [Syncs guide](https://developers.notion.com/workers/guides/syncs)
- [Linear GraphQL API](https://linear.app/developers/graphql)
- [Contribute to this cookbook](../../../../CONTRIBUTING.md)
