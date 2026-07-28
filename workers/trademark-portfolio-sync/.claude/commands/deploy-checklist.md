---
description: Pre-flight checks before and after deploying the portfolio worker
---

Run through this with the user. Report each as pass/fail, fix what you can.

**Before deploy**

- `npm run check` and `npm test` pass.
- `src/config.ts` has the real owner name(s), not the `ACME Corporation`
  placeholder, and `sources` toggles match what's actually wired (don't
  enable `counselDocket` without the inbox env vars, or `spend` while the
  stub still returns `{}`).
- `.env` — **the keyless base needs none of these.** Check only the vars for
  what's enabled (all documented in `.env.example`), and confirm `.env` is
  gitignored (it is):
  - `TSDR_API_KEY` — optional US upgrade (same-day freshness + document tools)
  - `DOCKET_INBOX_PAGE_ID` + `NOTION_API_TOKEN` — `counselDocket` (the token
    also serves the attach / `refreshMarkImages` tools)
  - `IPA_CLIENT_ID` / `IPA_CLIENT_SECRET` — `ipAustralia`
  - `EUIPO_CLIENT_ID` / `EUIPO_CLIENT_SECRET` — `euipo`
  - `SPEND_CLIENT_ID` / `SPEND_CLIENT_SECRET` — `spend` (or whatever the
    adapter reads)
  - `PORTFOLIO_OWNERS`, `DOCKET_ALLOW_SHRINK`, `STALENESS_CAP_EXEMPT` —
    operator overrides; normally **unset**
- A local run looks right: `ntn workers exec portfolioBackfill --local`
  returns the expected rows.

**Deploy**

- `ntn login` to the intended workspace (confirm which one).
- `ntn workers deploy`. **If this fails with `403 WorkersCapabilityMissing`,
  `CapabilityNotEnabledError`, or a similar capability/permissions error:**
  Workers aren't fully enabled for this account. Confirm (a) the workspace is
  Business/Enterprise, (b) a **Workspace Owner** has enabled Workers for the
  workspace (see https://www.notion.com/help/understand-pricing-for-workers),
  and (c) since this worker uses **syncs**, the sync capability is enabled for
  the deploying user (it's gated per-user during the beta — request it via the
  Notion workspace admin / Notion Devs community). Deploying as a non-Owner
  Member can also be the blocker.
- Push secrets if there are any — **the deploy does not upload `.env`**:
  `ntn workers env push --yes` (uploads your whole local `.env`; `--yes` skips
  the confirm prompt an agent can't answer), or set them one at a time with
  `ntn workers env set KEY=value`. A fully keyless setup has nothing to push —
  skip this.
- `ntn workers sync trigger portfolioBackfill` — initial load AND schema
  migration. If the delta was already running and you changed the schema, the
  backfill must run first or the delta crashes on startup.

**After deploy**

- `ntn workers sync status` — all syncs healthy.
- The **Sync Health** database shows each enabled source "Up". This (not
  `sync status`) is your ongoing outage signal, since the delta degrades
  gracefully. Rows exist only for enabled sources, and **USPTO TSDR (keyed)**
  appears only once `TSDR_API_KEY` is set — no permanently-red rows for
  things that were never configured.
- The delta is scheduled hourly; the backfill is manual (re-run it to sweep
  deletes or after schema changes).
- **Icons after a backfill:** a backfill re-emits every row, and an upsert
  without an icon field clears the page icon — so backfills wipe mark-image
  icons. Re-run the `refreshMarkImages` tool (locally — TMview's thumbnail
  endpoint blocks datacenter egress) to restore them; the "Mark Image" column
  itself survives re-emits.

**If the delta fails instantly with empty logs:** almost always an unmigrated
schema change — run `portfolioBackfill` once, then re-trigger the delta. If it
persists, the sync state may have outgrown the ~200KB start cap — see the
`sync-engine` skill (`ntn workers sync state reset` is the recovery).
