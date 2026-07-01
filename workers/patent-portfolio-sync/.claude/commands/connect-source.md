---
description: Connect or replace a data source (docketing, spend, or another patent office)
---

Help the user wire a source into the portfolio. First read the
`source-adapter` skill — it has the `PatentRecord` contract and the pacer /
projection rules. Ask which kind of source this is, then:

## Docketing system (links offices into families + adds docket numbers)

Examples: Anaqua, Foundation IP, CPA Global, an in-house DB, a CSV export.

1. Ask how it authenticates and where credentials come from; add the variable
   to `.env.example` (with a comment) and `.env`.
2. Implement `lookup()` in `src/sources/docketing.example.ts` to return
   `{ [applicationNumber]: { docketNumber, familyId } }`. `familyId` is what
   groups US + EP (+ …) into one family — derive it from the docket via the
   `familyRegex` in `config.ts` (help them write that regex for their format).
3. Set `config.sources.docketing = true` and `config.docket`.
4. Verify with `ntn workers exec portfolioBackfill --local` — confirm rows now
   have a Docket # and that family rows (Parent relations) appear.

## Spend / e-billing system (adds cost per family)

Examples: SimpleLegal, Legal Tracker, TyMetrix, an AP export.

1. Auth → `.env`. 2. Implement `lookup(keys)` in `spend.example.ts` returning
   `{ [familyId]: { realized, pending } }`. If it needs one call per matter, read
   the `sync-engine` skill on resolution budgeting — chunk across cycles, don't
   fetch everything in one execute. 3. Set `config.sources.spend = true`. 4. Verify.

## Another patent office (e.g. WIPO, JPO, a national register)

Heads-up: offices are wired by fixed keys (`uspto`, `epo`), not a plug-in
registry, so a new office touches several files together — more than docketing
or spend do.

1. Copy `src/sources/uspto.ts` as a model; implement
   `fetch<Office>Records(applicants, pace)` (discovers by applicant, returns
   `PatentRecord[]`) and a cheap `probe<Office>(pace)` for health.
2. Add the new value to the `Jurisdiction` type (`types.ts`) and to the
   `Jurisdiction` + `Source` schema selects (`schema.ts`).
3. In `index.ts`, declare a `worker.pacer(...)` sized to the office's rate
   limit **and** add its `.wait()` to the `pacers = { uspto, epo }` object;
   then widen `BuildOpts.pacers` in `join.ts` to include the new key.
4. In `join.ts`, fetch and probe the office through `runner.run(...)` the same
   way `uspto`/`epo` already are, passing the new `pace` callback.
5. `npm run check`, then verify with `ntn workers exec portfolioBackfill --local`.

After any of these, if you added or changed a column, follow the lockstep rule
(schema + builder + fingerprint) and remember: schema change → run the
backfill before the delta.
