---
name: sync-engine
description: How the resilience, sync-state, change-detection, and resolution-budgeting engine works. Read before editing src/engine/, before adding any enrichment that makes one API call per item, or when a sync crashes with empty logs / state-size errors / handler timeouts.
---

# Sync engine

The reusable machinery in `src/engine/` is mature — most customization never
touches it. But its constraints shape everything you add. Respect these four.

## 1. Resilience (`resilience.ts`)

Every source fetch goes through `SourceRunner.run(key, fetcher, absentFallback?)`:

- **Success** → records the payload as a snapshot + marks the source healthy.
- **Failure, strict mode (backfill)** → throws. A replace cycle must never emit
  partial data, or mark-and-sweep deletes live rows. **Never make the backfill
  resilient.**
- **Failure, resilient mode (delta)** → serves the last-known-good snapshot if
  it's within `STALENESS_CAP_MS` (24h); past the cap (or no snapshot) it
  rethrows — fail loud, don't serve indefinitely-stale data.
- **Bootstrap caveat:** resilience needs one prior successful fetch to have a
  snapshot. `STALENESS_CAP_EXEMPT` (env, comma-separated source keys) lets a
  source serve a beyond-cap snapshot, or use its `absentFallback` when there's
  no snapshot at all — the operator escape hatch for prolonged outages.

New sources get resilience for free by fetching inside `runner.run("key", …)`.

## 2. Sync-state size — TWO limits (`state.ts`)

- The platform **rejects saves over 256KB**.
- A run **fails to _start_** (instant exit, empty logs) when handed state above
  **~200KB** — below the save cap. A state that saved fine can poison every
  subsequent run; recovery needs `ntn workers sync state reset <key>`.

So: snapshots are stored gzip+base64 (`packSnapshots`/`unpackSnapshots`), and
you **project at the fetch boundary** — keep only the fields the join reads,
drop the rest before it ever enters a snapshot. Each delta logs
`packed snapshots <N>B`; if it climbs toward ~150KB, shrink projections before
it bites. The failure mode gives no error message, so this is on you to watch.

## 3. Change detection (`fingerprint.ts`)

The delta emits a row only when `fingerprint(row.fingerprintBasis)` changes.
`DERIVATION_VERSION` is folded into every fingerprint:

- A new column whose value is already in the basis → re-emits automatically.
- A change to how an existing column is _computed_ (inputs unchanged) → the
  delta can't tell; **bump `DERIVATION_VERSION`** to force a one-time full
  re-emit. Exclude volatile values (like a per-run timestamp) from the basis,
  or every row re-emits every cycle.

## 4. Resolution budgeting (the ~5-minute handler limit)

Any enrichment that makes **one API call per item** (INPADOC family per family,
forward citation per publication, spend per matter) can blow the handler's
~5-minute budget on a cold cache. Two patterns:

- **Backfill: chunked resolve phase.** Do a bounded chunk of lookups, return
  `hasMore: true` with **no changes**, carrying partial caches in `nextState`,
  until a final execute emits all rows. (Replace-mode mark-and-sweep only fires
  on the last `hasMore: false`.) Track an "attempted this cycle" set so items
  that can't resolve (e.g. unpublished families) don't block convergence.
- **Delta: rotating TTL'd refresh.** Persist resolved values in sync state;
  each cycle refresh only the N oldest-fetched items (e.g. INPADOC ~daily,
  forward citations ~weekly). Stale is fine for these — the values only
  accrete, so a missed refresh just delays new data, never corrupts.

Cache stable lookups permanently (INPADOC family IDs don't change); re-resolve
volatile ones on the TTL.

## Operational reminders

- **Schema change → run the backfill before the delta**, or the delta crashes
  on startup (the schema migration rides the backfill's replace write).
- `nodenext` modules: relative imports need `.js` extensions.
