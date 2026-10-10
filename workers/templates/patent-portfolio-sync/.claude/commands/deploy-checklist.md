---
description: Pre-flight checks before and after deploying the portfolio worker
---

Run through this with the user. Report each as pass/fail, fix what you can.

**Before deploy**

- `npm run check` passes (no type errors).
- `.env` has the keys for every enabled source; `.env` is gitignored.
- `src/config.ts` has the real applicant name(s), not the `ACME Corporation`
  placeholder, and `sources` toggles match what's actually implemented (don't
  enable `docketing`/`spend` while they're still stubs).
- A local run looks right: `ntn workers exec portfolioBackfill --local` returns
  the expected rows.

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
- Push secrets to the remote env — **the deploy does not upload `.env`**:
  `ntn workers env push --yes` (uploads your whole local `.env`; `--yes` skips the confirm prompt an agent can't answer), or set them one at
  a time with `ntn workers env set KEY=value`. The triggered backfill fails
  without them.
- `ntn workers sync trigger portfolioBackfill` — initial load AND schema
  migration. If the delta was already running and you changed the schema, the
  backfill must run first or the delta crashes on startup.

**After deploy**

- `ntn workers sync status` — all syncs healthy.
- The **Sync Health** database shows each source "Up". This (not `sync status`)
  is your ongoing outage signal, since the delta degrades gracefully.
- The delta is scheduled hourly; the backfill is manual (re-run it to clean up
  deletes or after schema changes).

:**If you added family/Parent relations AFTER the database already
existed** (e.g. enabled a family-affecting feature in a later deploy): Notion's
Sub-items tree only engages when the database is _created_ with hierarchy data
present. Recreate it — delete the database in Notion, then
`ntn workers sync trigger portfolioBackfill` recreates it fresh with families
from the first populate. (A clean first-time setup never hits this — the family
grouping ships in the schema, so the first backfill always has the hierarchy.)

**If the delta fails instantly with empty logs:** almost always an unmigrated
schema change — run `portfolioBackfill` once, then re-trigger the delta.
