---
name: sync-engine
description: How the resilience, sync-state, change-detection, and resolution-budgeting engine works. Read before editing src/engine/, before adding any enrichment that makes one API call per item, or when a sync crashes with empty logs / state-size errors / handler timeouts.
---

# Sync engine

The reusable machinery in `src/engine/` is mature — most customization never
touches it. But its constraints shape everything you add. Respect these five.

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

## 2. Sync-state size — TWO limits, one of them MOVING (`state.ts`)

- The platform **rejects saves over 256KB**.
- A run **fails to _start_** (instant exit, empty logs) when handed state above
  an **undocumented run-input ceiling that has tightened over time** — ~200KB
  held in June 2026, but production workers wedged at **~99KB in August 2026**
  on the current SDK. Treat the ceiling as unknowable and budget total state
  to stay **well under ~80KB**. A state that saved fine can poison every
  subsequent run.

Recognize the wedge: failed runs exit in ~2 seconds with completely empty
logs, and `ntn workers sync status <key> --json` shows
`lastSystemErrorMessage: "The request to the worker was invalid"` (run logs
never mention it). `ntn workers sync state reset <key>` recovers but is only
a stopgap — the wedge returns as state regrows; the durable fix is persisting
less.

So: snapshots are stored gzip+base64 (`packSnapshots`/`unpackSnapshots`), you
**project at the fetch boundary** — keep only the fields the join reads, drop
the rest before it ever enters a snapshot — and you **pre-aggregate unbounded
terms**: never snapshot per-transaction rows whose count only grows (invoices
are the classic trap); reduce them to per-entity sums at the boundary so the
snapshot tracks portfolio size, not history. `assertSafeSyncState` measures the
entire serialized state and rejects it at 78,000 UTF-8 bytes before a sync can
return changes. Each persisted backfill/delta state logs that total. Portfolio
capacity is data-dependent; if the guard fires, shrink projections or move the
frozen data to durable sharded storage. Do not raise the threshold toward the
observed platform ceiling: a state that saves successfully can still wedge the
next run before user code starts.

## 3. Change detection (`fingerprint.ts`)

The delta emits a row only when `fingerprint(row.fingerprintBasis)` changes.
`DERIVATION_VERSION` is folded into every fingerprint:

- A genuinely new input added to the basis changes the hash and re-emits.
- A new output column derived entirely from inputs already in the basis, or a
  change to how an existing column is computed from unchanged inputs, does not
  change the hash. **Bump `DERIVATION_VERSION`** to force a one-time full
  re-emit. Exclude volatile values (like a per-run timestamp) from the basis,
  or every row re-emits every cycle.

## 4. Frozen acquire/emit pagination (`index.ts`)

Backfill and mass-change delta cycles fetch once, then emit 100-row pages from
the same compressed snapshot. A versioned `phase: "emit"` state carries the
cycle timestamp, frozen snapshots, and compressed pending row keys; delta state
also carries source health. Later pages reconstruct rows locally and make
**zero network calls**.
Never replace this with an offset plus a fresh fetch: an upstream insert,
delete, or reorder between pages can otherwise skip or duplicate rows, and an
outage can roll a fresh delta page back to older last-known-good data.

Validate every persisted phase, version, timestamp, health entry, packed blob,
and pending key before using it. If `DERIVATION_VERSION` changes during an
in-progress emit phase, fail and restart the cycle instead of mixing two row
derivations.

## 5. Resolution budgeting (the ~5-minute handler limit)

Any enrichment that makes **one API call per item** (INPADOC family per family,
forward citation per publication, spend per matter) can blow the handler's
~5-minute budget on a cold cache. Two patterns:

- **Backfill: chunked resolve phase.** Do a bounded chunk of lookups, return
  `hasMore: true` with **no changes**, carrying partial caches in `nextState`,
  until resolution is complete. Then transition to the same bounded 100-row
  frozen emit pagination used by the base worker; never emit an unbounded final
  page. (Replace-mode mark-and-sweep only fires on the last `hasMore: false`.)
  Track an "attempted this cycle" set so items that can't resolve (e.g.
  unpublished families) don't block convergence.
- **Delta: rotating TTL'd refresh.** Persist resolved values in sync state;
  each cycle refresh only the N oldest-fetched items (e.g. INPADOC ~daily,
  forward citations ~weekly). A missed refresh delays upstream corrections as
  well as additions; citation reprocessing can reduce a previously observed
  count, so preserve the last validated value and its refresh timestamp.

Cache stable lookups permanently (INPADOC family IDs don't change); re-resolve
volatile ones on the TTL.

## Operational reminders

- **Schema change → run the backfill before the delta**, or the delta crashes
  on startup (the schema migration rides the backfill's replace write).
- `nodenext` modules: relative imports need `.js` extensions.
