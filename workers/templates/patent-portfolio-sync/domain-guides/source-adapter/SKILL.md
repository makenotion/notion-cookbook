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

- Export `async function fetch<Office>Records(applicants: string[], pace: () => Promise<void>, deadlineMs?: number): Promise<PatentRecord[]>` and honor the
  shared acquisition deadline before starting another request.
- `await pace()` **before every HTTP request** — `pace` is one of the shared
  pacers' `wait()`. Wiring a _new_ office's pacer is more than a
  `worker.pacer(...)` declaration (see the new-jurisdiction note below).
- Set `source`, `jurisdiction`, `applicationNumber` (the canonical identifier
  defined in `types.ts`; the join adds the jurisdiction-prefixed row key), and
  `title`. Everything else is nullable — populate what the office gives, leave
  the rest null.
- **Project at the fetch boundary:** keep only fields you map onto
  `PatentRecord`; never stuff raw API payloads into the record (state-size
  discipline — see `domain-guides/sync-engine/SKILL.md`).
- Compute office-specific derived fields here (e.g. `estExpiry` — only once
  granted; term math differs per office).
- Return a **complete result or throw**. If any discovery page or required
  per-application detail cannot be retrieved or validated, reject the whole
  source so strict backfills abort and resilient deltas can serve the previous
  complete snapshot. Never silently skip an application: with source-level
  snapshots, a partial success is indistinguishable from a deletion.
- Export a bounded `probe<Office>(pace)` for `healthSync` that exercises every
  critical service path used by acquisition without scanning a portfolio. A
  limit-1 search is sufficient only when the adapter has no separate detail
  path; EPO deliberately probes both search and full-record retrieval. Import
  and wire the probe in `index.ts`'s `HEALTH_ENDPOINTS`.

Adding a new jurisdiction touches several files together, because sources are
wired by fixed keys (`uspto`, `epo`), not a registry:

- the `Jurisdiction` type (`types.ts`) and the `Jurisdiction` + `Source`
  selects (`schema.ts`);
- a `worker.pacer(...)` in `index.ts`, **plus** its `.wait()` added to the
  `pacers = { uspto, epo }` object there, **plus** the new key added to
  `BuildOpts.pacers` in `join.ts`;
- the `runner.run(...)` fetch in `join.ts`, following how `uspto`/`epo` are
  already wired, plus the health probe in `index.ts`'s `HEALTH_ENDPOINTS`.

## Docketing adapter (`docketing.example.ts`)

Implements `DocketingAdapter.lookup(records) → { [applicationIdentity]: { docketNumber, familyId } }`.
Prefer jurisdiction-qualified keys such as `US:17123456` and `EP:16730001`.
Bare application numbers remain compatible only when exactly one fetched
jurisdiction matches; ambiguity fails closed. `familyId` links US and EP rows
into one family. An explicit `familyId: null` leaves that application ungrouped;
an absent lookup entry can inherit the one docket family assigned elsewhere in
its public continuity component. Derive the id from the docket number using
`config.docket.familyRegex`. Return `{}` only when the implemented source truly
has no enrichment; the shipped example stub deliberately throws if enabled.

## Spend adapter (`spend.example.ts`)

Implements `SpendAdapter.lookup(keys) → { [familyId]: { realized, pending } }`,
where `keys` are the family IDs present in the portfolio. Return only requested
keys and finite, non-negative numeric totals; malformed results are source
failures so a resilient delta can serve its prior valid snapshot. If your
billing system needs one call per matter, read the **Resolution budgeting**
section in `domain-guides/sync-engine/SKILL.md` — chunk across cycles and cache
in state; don't fetch everything in one execute.

## After writing an adapter

1. Toggle it on in `config.ts` (`sources.*`).
2. If it adds a column, follow the lockstep rule (schema + builder +
   fingerprint — see `/customize-schema`).
3. `npm run check`, then `ntn workers exec portfolioBackfill --local` to
   verify the rows look right before deploying.
