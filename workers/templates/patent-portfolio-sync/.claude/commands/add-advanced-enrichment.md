---
description: Add opt-in advanced enrichment (INPADOC families, citations, US prosecution/term metadata, EP orphan audit and register detail)
---

The user wants to add one or more advanced enrichment features beyond the lean
baseline. **Read `domain-guides/advanced-enrichment/SKILL.md` first** — it has
the implementation recipe for each, including the exact API endpoints and the
hard-won gotchas (e.g. INPADOC application refs need docdb dot form). Then read
`domain-guides/sync-engine/SKILL.md` if you're adding anything that makes one
API call per item, because those must be budgeted/rotated across cycles.

If the user reached here from `/setup`, you already have their selection.
Otherwise, ask which they want (multi-select):

1. **INPADOC family IDs** — worldwide family grouping from EPO; a docket↔INPADOC
   mismatch is a real audit signal. Adds an `INPADOC Family ID` column.
2. **Forward-citation counts** — renew-vs-prune value signal; per-publication
   OPS search on a rotating refresh.
3. **US term & prosecution metadata** — PTA days, Track One, art unit, and
   terminal disclaimer. Mostly free — already in the USPTO search payload.
   Publication number is already a base field. This does not calculate legal
   deadlines.
4. **EP orphan audit** — EP filings present at the office but missing from your
   docket (requires docketing enabled).
5. **EP register detail** — designated states, EPO application renewal-fee
   payments, and X/Y search-report citations (omitted from the lean base;
   renewals need a second OPS call per app and do not cover post-grant national
   renewal or legal status).

For non-US/EP grants, current legal status/events, or `Next Deadline` fields,
do not implement kind-code, influence-flag, or date-arithmetic heuristics.
Connect an authoritative docketing source or a jurisdiction-specific official
register through `/connect-source` and
`domain-guides/source-adapter/SKILL.md` instead.

Implement only what they pick. For each feature, follow the skill's recipe and
the lockstep rule (schema + builder + fingerprint). Features 1 and 2 add
per-item OPS calls — wire in the resolution
budgeting from `domain-guides/sync-engine/SKILL.md` (chunked backfill resolve
phase + rotating TTL'd refresh in the delta) so you stay under the ~5-minute
handler limit and the platform's undocumented run-input state ceiling
(observed as low as ~99KB in August 2026 — budget total state well under
~80KB).

When done: `npm run check`, verify with `--local`, then on deploy run the
backfill before the delta (schema change), and bump `DERIVATION_VERSION` so
existing rows re-emit with the new fields.
