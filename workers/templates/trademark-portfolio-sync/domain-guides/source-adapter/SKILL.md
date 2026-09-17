---
name: source-adapter
description: The source contracts (UsCase, ForeignMark, OfficialOverlay, DocketEntry/DocketAction, SpendAdapter) and how to write or modify an adapter — pace() injection, projection at the fetch boundary, the zero-hits-throws rule for enumeration sources, and the single-request probe rules. Read before adding an office, overlay, or spend system.
---

# Source adapters

An adapter turns one upstream into data the join can use. The contracts live
in `src/sources/types.ts`; three families feed the portfolio.

## Registry adapters (`uspto.ts` → `UsCase`, `tmview.ts` → `ForeignMark`)

Discover marks for `config.ownerNames` and normalize them: `UsCase` keyed by
the 8-digit serial, `ForeignMark` keyed by ST13 — the key becomes the row
key. Contract:

- **`pace` is injected, never imported.** Adapters take the pacer `wait()`
  callback(s) as a parameter (`fetchUsCases` takes `{ search, tsdr }`,
  `fetchForeignMarks` a single `pace`) and `await` it **before every HTTP
  request**. That keeps sources callable from syncs, probes, and tests alike.
- **Project at the fetch boundary.** Keep only the fields the declared type
  carries — tmsearch narrows `_source` to `TMSEARCH_SOURCE_FIELDS`, and
  `projectTmsearchHit` / `projectMark` map straight to the type. Whatever you
  keep rides in the delta's gzipped snapshots forever (state-size discipline
  — see `sync-engine`). Never stash a raw API payload on a record.
- **Zero hits THROWS.** Both keyless backends are WAF-fronted, and a
  challenge page can parse as a well-formed _empty_ result — while an owner
  with zero marks is not a reachable state for a portfolio this template
  syncs. Returning `{}` would hand the strict backfill an empty row set to
  mark-and-sweep the whole portfolio with; throwing lets the resilient delta
  serve its snapshot instead. Any enumeration source you add must keep this
  rule.
- **Tolerate per-item failure; fail whole-source loudly.** A failed TMview
  detail fetch nulls that one mark's `statusDate` (best-effort); discovery
  itself failing throws so the runner can serve the snapshot.
- Nullable everywhere: populate what the office gives, leave the rest null.

## Official overlays (`ipaustralia.ts`, `euipo.ts` → `OfficialOverlay`)

`fetch<Office>Overlays(applicationNumbers, pace)` returns
`Record<applicationNumber, OfficialOverlay>`, applied onto the matching
`ForeignMark`s. Overlays are **enrichment, never row-defining**: per-number
failures skip that mark's refinement; only a credentials failure fails the
source (bad credentials belong in Sync Health, not behind an empty overlay).
Adding one:

1. Copy `ipaustralia.ts` as the model. Read credentials at CALL time — env is
   injected per run, and a module-scope read bakes in the empty deploy-time
   value.
2. Wire it into the overlay step of `buildPortfolioRows` (`join.ts`) through
   `runner.run(...)` inside its own try/catch, exactly like the existing two
   — that's what makes it non-fatal.
3. Add a `config.sources` toggle and a `healthEndpoints()` entry in
   `index.ts`, gated on that toggle.
4. Share the `official` pacer — the platform caps a worker at 5 pacers, and
   overlays make a handful of calls per cycle.

The EUIPO lesson, worth keeping in mind for any approval-gated API: it issues
valid tokens BEFORE the subscription is approved, so data calls 401/403
during the window. Treat that as a source failure, never a successful empty
result: throw so resilience can preserve a prior valid overlay, and probe a
REAL data call — a token probe would lie green for weeks.

## Counsel docket (`counsel-docket.ts` → `DocketEntry` + `DocketAction`)

The .xlsx-report ingester — parsing, guards, and adaptation are documented in
the `docket-inbox` skill; `/add-docket-inbox` is the guided setup.

## Spend (`spend.example.ts` → `SpendAdapter`)

`lookup(keys)` receives `{ serial, wordmark }` pairs and returns
`Record<serial, { realized, pending }>`. Trademark invoices rarely carry
anything docket-shaped, but e-billing systems usually name matters after the
mark — normalized wordmark matching is the practical join (the stub's
commented example shows it: a ≥4-char guard so a short mark doesn't match
half the ledger, and an even integer-cents split across marks sharing a
wordmark so column totals stay truthful). One call per matter? Read
`sync-engine` on budgeting — chunk across cycles, cache in state.

## Probes (`healthSync`)

- Probe **only enabled sources** — a permanently-red row for an office that
  was never configured drowns the real outage signal. Key-gated probes (TSDR)
  appear only when their key is configured, checked at run time.
- Probes must be **single-request and cheap**. Probed through the full fetch
  path, a 15-minute health check is ~2,000 requests/day — enough to starve
  the shared pacers AND look like scraping to a WAF that already blocks
  datacenter ranges. TMview's probe is one `basicSearch` for a common word;
  zero hits for it means a block, never an empty result.
- `counselDocket` is the deliberate exception (a full dry-run), because that
  sync's failure mode is silent by design — see `docket-inbox`.

## After writing an adapter

1. Toggle it on in `config.ts` (`sources.*`) — toggles are compile-time, so
   redeploy.
2. If it adds a column, follow `/customize-schema` (schema + builder; the
   fingerprint follows the builder automatically).
3. `npm run check` and `npm test`, then
   `ntn workers exec portfolioBackfill --local` to verify the rows before
   deploying. If the schema changed, run the backfill before the delta.
