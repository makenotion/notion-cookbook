---
name: sync-engine
description: How the resilience, sync-state, change-detection, and budgeting engine works, plus the join's trust order (counsel docket first and strict-fatal; overlays and spend never cycle-fatal). Read before editing src/engine/ or the assembly in src/join.ts, or when a sync crashes with empty logs / state-size errors / handler timeouts.
---

# Sync engine

The reusable machinery in `src/engine/` is mature — most customization never
touches it. But its constraints shape everything you add. Respect these five.

## 1. Resilience (`resilience.ts`) — per-source staleness caps

Every source fetch goes through `SourceRunner.run(key, fetcher, opts?)`:

- **Success** → records the payload as a snapshot + marks the source healthy.
- **Failure, strict mode (backfill)** → throws. A replace cycle must never
  emit partial data, or mark-and-sweep deletes live rows. **Never make the
  backfill resilient.**
- **Failure, resilient mode (delta)** → serves the last-known-good snapshot
  while it's within the source's cap; past the cap (or with no snapshot) it
  rethrows — fail loud, don't serve indefinitely-stale data.

Caps are per-source (`opts.capMs`), sized to how the data decays: the default
is 24h (`STALENESS_CAP_MS`); the keyless WAF-fronted registries (`uspto`,
`tmview`) get `WAF_STALENESS_CAP_MS` (7 days) — a WAF block can outlast a day
while the underlying data barely moves; `counselDocket` gets `Infinity` — a
docket report stays the truth until the next one arrives.

Serving from cache is **never silent**: every served snapshot logs
`[resilience] "<key>" failed — serving snapshot from <when>`. The delta still
reports HEALTHY while doing it, so that log line and the Sync Health table
are the only tells that fresh data isn't being ingested. `lastError` is
truncated to 500 chars on purpose — WAF block pages arrive as full HTML
documents, and `sourceHealth` persists raw (ungzipped) in sync state.

Bootstrap caveat: resilience needs one prior successful fetch to have a
snapshot. `STALENESS_CAP_EXEMPT` (env, comma-separated source keys, read at
call time) lets a source serve a beyond-cap snapshot, or use its
`absentFallback` when there's no snapshot at all — the operator escape hatch
for prolonged outages. Unset it when the outage ends.

## 2. The join's trust order (`join.ts`)

Assembly order encodes the trust model — don't reorder it:

1. **Counsel docket is resolved FIRST, and is STRICT-fatal when enabled.**
   Deadline overrides, lapse flags, and docket-only rows feed every other
   builder — and a replace sweep built without the docket would delete the
   docket-only rows, with the delta's unchanged fingerprints keeping the
   deletion invisible afterwards.
2. **USPTO, then TMview** — row-defining; strict failures abort; both throw
   on zero hits (a WAF challenge parses as a valid _empty_ result, and zero
   marks is not a reachable state for a synced portfolio).
3. **Official overlays and spend — never cycle-fatal, even in strict mode.**
   A strict backfill must be runnable while an office API is down; affected
   rows carry TMview's values until it recovers, and the fingerprints
   self-heal the enriched values.

## 3. Sync-state size — TWO limits (`state.ts`)

- The platform **rejects saves over 256KB**.
- A run **fails to _start_** (instant exit, empty logs) when handed state
  above **~200KB** — below the save cap. A state that saved fine can poison
  every subsequent run; recovery needs `ntn workers sync state reset <key>`.

So: snapshots are stored gzip+base64 (`packSnapshots`/`unpackSnapshots`), and
you **project at the fetch boundary** — keep only the fields the join reads.
Each delta logs **both** figures: `packed snapshots <N>B, total state ~<M>B` —
fingerprints and `sourceHealth` ride raw alongside the gzipped snapshots, so
watch the total, not just the packed number. If it climbs toward ~150KB,
shrink projections before it bites; the failure mode has no error message.

## 4. Change detection (`fingerprint.ts`)

The delta emits a row only when `fingerprint(row.fingerprintBasis)` changes —
and here the basis IS the row's built properties, captured just before
`Last Sync` is stamped. Consequences:

- A column you emit in a builder joins change detection automatically (no
  separate basis to maintain), and `Last Sync` advances only on rows that
  re-emit for a real change.
- Never emit a volatile per-run value in a builder, or every row re-emits
  every cycle.
- `DERIVATION_VERSION` is folded into every fingerprint **and** doubles as
  the counsel-docket `parserVersion` (part of the report parse-cache key).
  Bump it after changing a derivation rule or a report parser: it forces a
  one-time full re-emit and a re-parse of cached reports.

## 5. Budgeting (the ~5-minute handler limit)

- **Backfill: offset paging.** Each execute rebuilds the full,
  deterministically ordered row list and emits a `BATCH_SIZE` (100) slice,
  carrying only the cursor in `nextState`. Replace-mode mark-and-sweep fires
  only on the final `hasMore: false` — never on a partial page.
- **Delta: fingerprint paging.** On a mass-change cycle only the emitted
  page's fingerprints advance; the rest stay "changed" and emit next page, so
  an interrupted cycle resumes cleanly.
- **Per-item work is budgeted, not exhaustive.** TMview status dates cost one
  detail fetch per mark, so the adapter spends a ~20-fetch budget per cycle
  and carries forward the previous cycle's dates for the rest (stale beats
  blank; a cold portfolio converges over 2-3 cycles). Copy that pattern —
  bounded chunk + carry-forward in state — for anything per-item you add
  (e.g. per-matter spend lookups).

## Operational reminders

- **Schema change → run the backfill before the delta**, or the delta crashes
  on startup (the migration rides the backfill's replace write).
- `nodenext` modules: relative imports need `.js` extensions.
