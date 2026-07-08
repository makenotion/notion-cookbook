---
name: advanced-enrichment
description: Implementation recipes (with exact API endpoints and gotchas) for the opt-in advanced features — INPADOC family IDs, JP/CN/WO grant detection + legal events, forward citations, US term/prosecution fields, the EP orphan audit, and EP register detail (designated states / renewals / X-Y citations). Drives /add-advanced-enrichment.
---

# Advanced enrichment recipes

Each is independent — implement only what the user picked. All follow the
lockstep rule (schema + builder + fingerprint) and, where they make one call
per item, the resolution budgeting in the `sync-engine` skill. Add per-item
OPS work behind the existing `epoApi` pacer.

## Common OPS notes

- Base: `https://ops.epo.org/3.2/rest-services`. Reuse the token helper in
  `epo.ts` (OAuth client-credentials, ~20-min cached token).
- OPS JSON is mechanically-converted XML: a node is a single object or an
  array; text lives under `"$"`. Reuse `epo.ts`'s `opsArr` / `opsText`.
- **Application references only resolve in docdb dot form** — `US.<filing-year><serial>`, e.g. `US.202012345678`
  (country `.` year+serial). The epodoc application form 404s even for
  published cases. Publication references use epodoc (e.g. `US11234567`, `EP1234567`).

## 1. INPADOC Family ID

EPO-computed worldwide family (all members sharing a priority). A docket↔INPADOC
mismatch flags shared priority across "separate" dockets — a real audit signal.

- **Call:** `GET /family/{publication|application}/{epodoc|docdb}/{ref}` →
  `ops:world-patent-data.ops:patent-family.ops:family-member[]`; the family id
  is the `@family-id` attribute on any member.
- **Handles per family, in reliability order:** US grant publication (epodoc),
  EP publication (epodoc), then US/EP application refs in **docdb dot form**.
  Try each until one resolves.
- **Stable once known** — cache `{ familyId → inpadocId }` permanently in sync
  state; steady-state cycles make ~0 calls. Unresolved families (unpublished)
  retry next cycle.
- Adds `INPADOC Family ID` (richText), stamped on every member row of a family.

## 2. JP/CN/WO grant detection + adverse legal events

The jurisdictions with no public API of their own — enrich via the INPADOC
family response.

- **Call:** the same family endpoint, plus the `/legal` constituent appended
  (`…/{ref}/legal`) for legal events — one call gets members + events.
- **Members** carry `publication-reference.document-id` (docdb) with country +
  kind. **Grant detection:** a `B*`/`C*` kind publication for that country →
  Status "Issued", Grant Date = its date, Patent # = `<CC><docNumber>`.
- **Legal events:** each `ops:legal` has an `@infl` ("+", "-", " ") and `@desc`;
  the **negative-influence (`@infl === "-"`)** ones are lapses/withdrawals/
  fee-non-payment. Surface the latest as `Adverse Legal Event` / `Adverse Event
Date` (date is the `L007`-suffixed field). Blank when healthy.
- A docket "Abandoned"/withdrawn status should win over a detected grant.
- **Budget:** rotating member refresh (per-family `fetchedAt`, ~daily TTL) —
  see `sync-engine`. Match a docketed matter to its family member by
  application digits, else the sole member of that jurisdiction.

## 3. Forward-citation counts

Renew-vs-prune value signal: how many later publications cite this one.

- **Call:** `GET /published-data/search?q=ct=<publicationNumber>&Range=1-1` →
  `ops:world-patent-data.ops:biblio-search.@total-result-count`. **A 404 means
  zero hits** (not an error) — record 0.
- Per-publication, so **budget it:** rotating ~weekly refresh, oldest-first, a
  handful per cycle. Best-effort in both modes — counts only grow, stale is
  never wrong.
- Adds `# Forward Citations` (number) on rows that have a publication number.

## 4. US term & prosecution fields

Mostly **free** — already in the USPTO search payload (`uspto.ts`), no new
calls. Extend `OdpRecord`/projection + `PatentRecord` + schema/builder:

- **PTA:** `patentTermAdjustmentData.adjustmentTotalQuantity` (granted cases).
  Add to the term math: granted expiry = base + 20y + PTA days. Column `PTA Days`.
- **Track One:** event codes `T1GR`/`PDTG` in `eventDataBag` → `Track One`
  checkbox.
- **Terminal disclaimer:** event code `DIST` ("Terminal Disclaimer Filed") →
  `Terminal Disclaimer` checkbox. (A TD can shorten the real term to a
  referenced patent's — the estimate doesn't model that; the flag is the
  caveat.)
- **Art unit:** `applicationMetaData.groupArtUnitNumber` → `Art Unit`.
- **Publication #:** `pgpubDocumentMetaData.xmlFileName` encodes it as
  `<appNumber>_<publicationNumber>.xml` → `US<publicationNumber>`.
- **Maintenance-fee schedule** (`Next Renewal Due`): granted US utility owes
  fees at grant + 3.5 / 7.5 / 11.5 years. Detect payments from event codes
  `M{1,2,3}55{1,2,3}` (entity × stage); the next unpaid window's date is due
  (overdue shows as-is — a lapse-risk signal). Designs/provisionals owe none.
- Remember to project these new fields at the fetch boundary (state size).

## 5. EP orphan audit

Surfaces EP filings present at the office but missing from your docket — only
meaningful with docketing enabled.

- **Call:** `GET /register/search?q=pa="<applicant>"` (the discovery the EPO
  adapter already does). Any returned EP application not matched to a docket
  number is an orphan.
- Emit it as a normal `Source: EPO` row with register data but a **blank
  Docket #** — the blank docket _is_ the audit flag. An exact-title match to a
  docketed-but-numberless matter can bind it; otherwise leave it flagged.
- Key orphans the same way they'll be keyed once docketed, so the row merges
  cleanly when the docket catches up.

## 6. EP register detail (designated states, renewals, X/Y citations)

EPO data the base adapter deliberately omits to stay lean. Add fields to
`PatentRecord`, parse them in `fetchRegister` (`src/sources/epo.ts`), and add
the columns + builder lines.

- **Designated states:** from the biblio already fetched —
  `bib["reg:designation-of-states"][0]["reg:designation-pct"]["reg:regional"]["reg:country"]`.
  Column `Designated States` (richText, space-joined). Cheap (no extra call).
- **X/Y search-report citations:** also from biblio —
  `bib["reg:references-cited"]["reg:citation"][].["reg:category"]` ("X" =
  novelty-destroying alone, "Y" = inventive-step in combination). Count each
  → `X Category Citations` / `Y Category Citations` (number). Cheap.
- **Renewal-fee payments:** a SECOND call,
  `GET /register/application/epodoc/<epodoc>/procedural-steps` → steps with
  `reg:procedural-step-code === "RFEE"`; the second `procedural-step-text` is
  the renewal year, the `DATE_OF_PAYMENT` step date is when paid. Highest year
  wins → `Last Renewal Year` (number) / `Last Renewal Paid` (date). This
  doubles EPO calls per app, so mind the pacer/budget on large EP portfolios.

After implementing any of these: bump `DERIVATION_VERSION` so existing rows
re-emit with the new fields, `npm run check`, verify with `--local`, and on
deploy run the backfill before the delta.
