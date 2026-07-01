---
name: source-adapter
description: The PatentRecord contract and how to write or modify a source adapter (patent office, docketing, or spend). Read before adding a source or changing how an existing one fetches/normalizes data.
---

# Source adapters

A source adapter turns one upstream into data the join can use. Three kinds,
all in `src/sources/`.

## Patent-office adapter (e.g. `uspto.ts`, `epo.ts`)

Discovers applications for the configured applicant(s) and normalizes them to
`PatentRecord[]` (shape in `types.ts`). Contract:

- Export `async function fetch<Office>Records(applicants: string[], pace: () => Promise<void>): Promise<PatentRecord[]>`.
- `await pace()` **before every HTTP request** — `pace` is one of the shared
  pacers' `wait()`. Wiring a _new_ office's pacer is more than a
  `worker.pacer(...)` declaration (see the new-jurisdiction note below).
- Set `source`, `jurisdiction`, `applicationNumber` (the office-format string;
  becomes the row key, jurisdiction-prefixed), and `title`. Everything else is
  nullable — populate what the office gives, leave the rest null.
- **Project at the fetch boundary:** keep only fields you map onto
  `PatentRecord`; never stuff raw API payloads into the record (state-size
  discipline — see `sync-engine`).
- Compute office-specific derived fields here (e.g. `estExpiry` — only once
  granted; term math differs per office).
- Tolerate partial failure: if one application's detail call fails, skip it and
  continue (the resilience layer handles whole-source failure). Discovery
  itself failing should throw, so the runner can serve the snapshot.
- Export a cheap `probe<Office>(pace)` for `healthSync` (auth round-trip or a
  limit-1 query — proves reachability without heavy work).

Adding a new jurisdiction touches several files together, because sources are
wired by fixed keys (`uspto`, `epo`), not a registry:

- the `Jurisdiction` type (`types.ts`) and the `Jurisdiction` + `Source`
  selects (`schema.ts`);
- a `worker.pacer(...)` in `index.ts`, **plus** its `.wait()` added to the
  `pacers = { uspto, epo }` object there, **plus** the new key added to
  `BuildOpts.pacers` in `join.ts`;
- the `runner.run(...)` fetch and health probe in `join.ts`, following how
  `uspto`/`epo` are already wired.

## Docketing adapter (`docketing.example.ts`)

Implements `DocketingAdapter.lookup(records) → { [applicationNumber]: { docketNumber, familyId } }`.
`familyId` is the join's family grouping key — it's what links a US row and its
EP sibling into one family and one family row. Derive it from the docket number
using `config.docket.familyRegex`. Return `{}` to add no enrichment.

## Spend adapter (`spend.example.ts`)

Implements `SpendAdapter.lookup(keys) → { [familyId]: { realized, pending } }`,
where `keys` are the family IDs present in the portfolio. If your billing
system needs one call per matter, **read `sync-engine` on resolution
budgeting** — chunk across cycles and cache in state; don't fetch everything in
one execute.

## After writing an adapter

1. Toggle it on in `config.ts` (`sources.*`).
2. If it adds a column, follow the lockstep rule (schema + builder +
   fingerprint — see `/customize-schema`).
3. `npm run check`, then `ntn workers exec portfolioBackfill --local` to
   verify the rows look right before deploying.
