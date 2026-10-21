---
description: Connect an optional source (Docket Inbox, IP Australia, EUIPO, or spend)
---

Help the user wire an optional source into the portfolio. First read the
`domain-guides/source-adapter/SKILL.md` — it has the adapter contracts and the pacer /
projection / probe rules. The base (USPTO + TMview) is always on and keyless;
ask which optional source this is, then:

## Counsel Docket Inbox (deadline overrides, lapse flags, counsel-only rows)

The highest-value upgrade. Don't wire it by hand — run `/add-docket-inbox`,
the full guided routine (inbox page, env vars, config, the message to send
counsel, verification). `domain-guides/docket-inbox/SKILL.md` documents the pipeline and
how to adapt the parsers when a firm's export format differs.

## IP Australia overlay (authoritative AU enrichment)

1. Free developer account at https://portal.api.ipaustralia.gov.au →
   subscribe to the **Australian Trade Mark Search API** → `IPA_CLIENT_ID` /
   `IPA_CLIENT_SECRET` in `.env`, pushed with `ntn workers env push --yes`.
2. Set `config.sources.ipAustralia = true` — toggles are compile-time, so
   redeploy.
3. Verify with `ntn workers exec portfolioBackfill --local`: AU rows pick up
   the official status and renewal due date. An **IP Australia** row appears
   in Sync Health (token-only probe — IP Australia doesn't issue tokens to
   unapproved clients, so the token proves everything).

Overlays are enrichment, never row-defining: an overlay outage never fails a
cycle (not even the strict backfill); affected rows carry TMview's values
until the office API recovers, and the fingerprints self-heal.

## EUIPO overlay (authoritative EU enrichment)

Same wiring: register at https://dev.euipo.europa.eu, subscribe to the
**Trademark Search API**, set `EUIPO_CLIENT_ID` / `EUIPO_CLIENT_SECRET`,
toggle `config.sources.euipo`, redeploy. **The onboarding trap:** EUIPO issues
perfectly valid tokens BEFORE the subscription is approved — only the data
calls 401/403 during the approval window. The worker treats that window as
a source failure, never as a successful empty result. Resilience preserves a
prior valid EUIPO overlay; without one, affected rows retain their TMview
baseline. The **EUIPO** health row probes a real data call precisely so it
stays red until approval lands. A red EUIPO row with everything else green
means "still waiting on EUIPO", not a bug.

## Spend / e-billing system (cost per mark)

Examples: SimpleLegal, Legal Tracker, TyMetrix, an AP export.

1. Auth → `.env` (`SPEND_CLIENT_ID` / `SPEND_CLIENT_SECRET`, or whatever the
   system needs — add the variable to `.env.example` with a comment).
2. Implement `lookup(keys)` in `src/sources/spend.example.ts`: `keys` are
   `{ serial, wordmark }` pairs, because e-billing systems usually name
   trademark matters after the mark — normalized wordmark matching is the
   practical join. The commented example in the stub shows it, including the
   ≥4-char guard and the even integer-cents split across marks sharing a
   wordmark. Return spend keyed by serial. If the system needs one call per
   matter, read `domain-guides/sync-engine/SKILL.md` on budgeting — chunk across cycles.
3. Set `config.sources.spend = true` — this adds the **Total Spend** /
   **Total Pending** columns, a schema change.
4. `npm run check`, verify with `--local`, deploy, then **run the backfill
   before the delta** (schema migration).

## A different registry office or overlay

Read `source-adapter` first. The short version: enumeration sources must
throw on zero hits (never hand a replace sweep an empty list), overlays wire
into the join's overlay step and share the `official` pacer, and every new
source needs a cheap single-request probe gated on its config toggle.
