---
name: advanced-enrichment
description: Implementation recipes (with exact API endpoints and gotchas) for the opt-in advanced features — INPADOC family IDs, forward citations, US term/prosecution metadata, the EP orphan audit, and EP register detail (designated states / EPO application renewals / X-Y citations). Drives /add-advanced-enrichment.
---

# Advanced enrichment recipes

Each is independent — implement only what the user picked. All follow the
lockstep rule (schema + builder + fingerprint) and, where they make one call
per item, the resolution budgeting in
`domain-guides/sync-engine/SKILL.md`. Add per-item OPS work behind the existing
`epoApi` pacer.

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

## Legal-data boundary for other jurisdictions

INPADOC family and legal-event data is supplementary discovery data, not an
authoritative current-status source. Do not infer a grant from a generic
`B*`/`C*` kind-code rule: kind codes are office-specific, may identify corrected
or amended publications, and a WO/PCT application never receives a WO grant.
Likewise, `ops:legal.@infl === "-"` does not prove that a right is currently
adverse or unhealthy; later reversals, corrections, and national-law events may
change the result.

Populate non-US/EP `Status`, `Grant Date`, `Patent #`, and current legal-event
fields only from an authoritative docketing source or a jurisdiction-specific
official register adapter with an exact, reviewed kind/event mapping. Leave the
fields null when the source cannot verify them. Build that integration through
`/connect-source` and `domain-guides/source-adapter/SKILL.md`, with the budget
from `domain-guides/sync-engine/SKILL.md` when it requires one call per matter.

## 2. Forward-citation counts

Renew-vs-prune value signal: how many later publications cite this one.

- **Call:** `GET /published-data/search?q=ct=<publicationNumber>` with the HTTP
  header `Range: 1-1` →
  `ops:world-patent-data.ops:biblio-search.@total-result-count`. **A 404 means
  zero hits** (not an error) — record 0.
- Per-publication, so **budget it:** rotating ~weekly refresh, oldest-first, a
  handful per cycle. Treat it as best-effort and timestamp the refresh; source
  corrections or reprocessing can reduce a previously observed count.
- Adds `# Forward Citations` (number) on rows that have a publication number.

## 3. US term & prosecution fields

Mostly **free** — already in the USPTO search payload (`uspto.ts`), no new
calls. Extend `OdpRecord`/projection + `PatentRecord` + schema/builder:

- **PTA:** `patentTermAdjustmentData.adjustmentTotalQuantity` (granted cases).
  Column `PTA Days`. Apply it only when the base adapter already produced an
  eligible US utility/plant term; do not turn a deliberately null reissue,
  reexamination, supplemental-examination, or otherwise unsupported estimate
  into a calculated expiry.
- **Track One:** event codes `T1GR`/`PDTG` in `eventDataBag` → `Track One`
  checkbox.
- **Terminal disclaimer:** event code `DIST` ("Terminal Disclaimer Filed") →
  `Terminal Disclaimer` checkbox. (A TD can shorten the real term to a
  referenced patent's — the estimate doesn't model that; the flag is the
  caveat.)
- **Art unit:** `applicationMetaData.groupArtUnitNumber` → `Art Unit`.
- **Publication fallback:** the base adapter already populates `Publication #`.
  If its primary fields are absent, `pgpubDocumentMetaData.xmlFileName` can
  encode the same value as `<appNumber>_<publicationNumber>.xml`; validate the
  filename before using it as a fallback, without adding another column.
- **Legal deadlines:** do not calculate `Next Deadline` or `Deadline Type` from
  office status/filing dates. Response periods, issue fees, priority and
  national-phase entry, maintenance, extensions, weekends/holidays, and
  post-grant obligations require matter-specific legal rules and event data.
  Source deadline fields from the authoritative docketing system (or a reviewed
  per-office deadline service) and leave them absent when unavailable.
- Remember to project these new fields at the fetch boundary (state size).

## 4. EP orphan audit

Surfaces EP filings present at the office but missing from your docket — only
meaningful with docketing enabled.

- **Call:** `GET /register/search/biblio?q=pa="<applicant>"` (the discovery the EPO
  adapter already does). Any returned EP application not matched to a docket
  number is an orphan.
- Emit it as a normal `Source: EPO` row with register data but a **blank
  Docket #** — the blank docket _is_ the audit flag. An exact-title match to a
  docketed-but-numberless matter can bind it; otherwise leave it flagged.
- Key orphans the same way they'll be keyed once docketed, so the row merges
  cleanly when the docket catches up.

## 5. EP register detail (designated states, EPO application renewals, X/Y citations)

EPO data the base adapter deliberately omits to stay lean. Add fields to
`PatentRecord`, parse them in the EPO Register normalization in
`src/sources/epo.ts`, and add the columns + builder lines.

- **Designated states:** from the biblio already fetched —
  `bib["reg:designation-of-states"][0]["reg:designation-pct"]["reg:regional"]["reg:country"]`.
  Column `Designated States` (richText, space-joined). Cheap (no extra call).
- **X/Y search-report citations:** also from biblio —
  `bib["reg:references-cited"]["reg:citation"][].["reg:category"]` ("X" =
  novelty-destroying alone, "Y" = inventive-step in combination). Count each
  → `X Category Citations` / `Y Category Citations` (number). Cheap.
- **EPO application renewal-fee payments:** a SECOND call,
  `GET /register/application/epodoc/<epodoc>/procedural-steps` → steps with
  `reg:procedural-step-code === "RFEE"`; the second `procedural-step-text` is
  the renewal year, the `DATE_OF_PAYMENT` step date is when paid. Highest year
  wins → `Last EPO Application Renewal Year` (number) /
  `Last EPO Application Renewal Paid` (date). These fields cover renewal fees
  paid to the EPO while the European application is pending; they do not report
  post-grant national renewal payments, national status, or enforceability.
  Those require the relevant national register or authoritative docket. This
  doubles EPO calls per app, so mind the pacer/budget on large EP portfolios.

After implementing any of these: bump `DERIVATION_VERSION` so existing rows
re-emit with the new fields, `npm run check`, verify with `--local`, and on
deploy run the backfill before the delta.
