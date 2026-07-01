---
description: Add opt-in advanced enrichment (INPADOC families, JP/CN/WO grants, citations, US term/maintenance, EP orphan audit)
---

The user wants to add one or more advanced enrichment features beyond the lean
baseline. **Read the `advanced-enrichment` skill first** — it has the
implementation recipe for each, including the exact API endpoints and the
hard-won gotchas (e.g. INPADOC application refs need docdb dot form). Then
**read `sync-engine`** if you're adding anything that makes one API call per
item, because those must be budgeted/rotated across cycles.

If the user reached here from `/setup`, you already have their selection.
Otherwise, ask which they want (multi-select):

1. **INPADOC family IDs** — worldwide family grouping from EPO; a docket↔INPADOC
   mismatch is a real audit signal. Adds an `INPADOC Family ID` column.
2. **JP/CN/WO grant detection + adverse legal events** — the jurisdictions with
   no public API of their own; grant via kind codes, lapses via legal events.
   (Most useful once docketing supplies those family members.)
3. **Forward-citation counts** — renew-vs-prune value signal; per-publication
   OPS search on a rotating refresh.
4. **US term & prosecution fields** — PTA days, Track One, art unit, terminal
   disclaimer, and the maintenance-fee schedule (`Next Renewal Due`). Mostly
   free — already in the USPTO search payload.
5. **EP orphan audit** — EP filings present at the office but missing from your
   docket (requires docketing enabled).
6. **EP register detail** — designated states, renewal-fee payments, and X/Y
   search-report citations (omitted from the lean base; renewals need a second
   OPS call per app).

Implement only what they pick. For each feature, follow the skill's recipe and
the lockstep rule (schema + builder + fingerprint). Several features (1, 3,
and 2's member refresh) add per-item OPS calls — wire in the resolution
budgeting from `sync-engine` (chunked backfill resolve phase + rotating TTL'd
refresh in the delta) so you stay under the ~5-minute handler limit and the
~200KB state limit.

When done: `npm run check`, verify with `--local`, then on deploy run the
backfill before the delta (schema change), and bump `DERIVATION_VERSION` so
existing rows re-emit with the new fields.
