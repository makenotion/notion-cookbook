---
name: docket-inbox
description: How the counsel-docket pipeline works end to end — the two report kinds and filename classification, newest-by-filename-date election, the parse fingerprint cache, the full validation guard set (headers, client number, owner ratio, shrink, zero actions, due dates), the silent-failure design and its health-probe alarm, how the join consumes the data, adapting the parsers to another firm's export, and the revert path. Drives /add-docket-inbox; read before editing src/sources/counsel-docket.ts.
---

# Docket Inbox

Outside counsel emails two .xlsx reports; nobody wants to babysit an ingest
script. So: someone drags the attachments onto a Notion "Docket Inbox" page,
and `src/sources/counsel-docket.ts` ingests the newest of each kind every
cycle — no redeploy, no cron. The two kinds:

- **Properties Report** — every right in the portfolio, one row per filing,
  all countries → `DocketEntry[]`. Feeds counsel-only rows (direct national
  filings no registry API enumerates) and the **Lapse Instructed** flag.
- **Docket Report** — upcoming statutory actions with counsel's exact due
  dates → `DocketAction[]`. Feeds **Next Deadline** overrides — counsel's
  docketed date beats any computed estimate.

Wiring: `DOCKET_INBOX_PAGE_ID` (page ID or URL; read at call time, no
redeploy) + `NOTION_API_TOKEN` (an integration with read access to that page
via page → Connections — a page move can silently drop that access; the
health probe surfaces it), plus `config.sources.counselDocket = true`
(compile-time; adds the Lapse Instructed column → schema change → backfill
before delta) and optionally `config.docketClientNumber`. `/add-docket-inbox`
is the guided setup.

## Which attachment gets ingested

- **Classification is by filename** (`classifyReportName`): `.xlsx` only;
  `/propert/i` → properties, `/docket\s*report/i` → docket. Keep the patterns
  mutually exclusive if you widen them. An unclassifiable .xlsx **warns every
  cycle** in the sync and **hard-fails the probe** — a dropped file matching
  neither pattern would otherwise be invisible forever.
- **Newest is elected by the filename's date token** (`reportDateFromName`:
  `MMDDYYYY` right before `.xlsx`), with the block's `last_edited_time` only
  as tiebreaker/fallback. Edit times lie: Notion bumps `last_edited_time` on
  ANY touch of the block (a caption edit, dragging it to a new position) and
  truncates it to the minute — trusting it alone can quietly re-elect an OLD
  report as latest. When an older-dated file does win over the previously
  ingested one, the sync logs a regression warning.

## The parse cache

Each kind carries a fingerprint `${parserVersion}:${blockId}:${lastEdited}`;
an unchanged inbox costs exactly one children listing per cycle — no
downloads, no re-parse. The two kinds ingest independently, so a
docket-report-only month works. `parserVersion` IS `DERIVATION_VERSION`, on
purpose: a fingerprint that ignored the code version would keep serving a
stale cached parse straight through a parser fix — **bump
`DERIVATION_VERSION` after any parser change.** One transport note: Notion-
hosted file URLs are short-lived S3 signatures minted fresh by every listing
— download promptly, with a PLAIN fetch (S3 rejects requests that carry an
auth header alongside the signature).

## The guard set (why a bad file can't rewrite the portfolio)

Both parsers validate hard enough that a wrong or truncated file FAILS the
source instead of quietly rewriting the portfolio. Properties Report:

- **Required headers** (`Mark Name`, `Country`, `Application #`,
  `Registration #`, `File Date`, `Registration Date`, `Status`,
  `Owner Name`, `Classes Combined`) or throw — a renamed column would
  otherwise silently blank its field portfolio-wide, and a renamed Owner
  Name would silently disable the wrong-client guard below.
- **Minimum rows** (`MIN_PORTFOLIO_ROWS`, 50): a full-portfolio export should
  dwarf it; a tiny sheet is a partial export or the wrong document.
- **Owner ratio:** ≥ 80% of owner-bearing rows must match `config.ownerNames`
  (case-insensitive substrings — the same strings that drive registry
  discovery). 80, not 100: licensees, prior owners, and pre-assignment
  records legitimately appear. Below it, this is almost certainly another
  client's report. Zero owner values across the sheet also throws (the
  column moved in a way the header check missed).
- **Shrink guard:** fewer than 60% of the previous ingest's rows → throw
  (ingesting would strip lapse flags and, after a backfill, sweep
  counsel-only rows). Arms from the second ingest; `DOCKET_ALLOW_SHRINK=1`
  overrides deliberately.
- Warn-only: unmapped countries (rows skip — extend `COUNTRY_TO_OFFICE`) and
  unparseable File/Registration dates (kept blank).

Docket Report:

- The header row sits below ~10 report-criteria rows and is located **by
  content** (`Current Due Date`); absence throws.
- **Client guard:** the criteria preamble's `Client: 123456` must match
  `config.docketClientNumber` — a report exported for another client is
  someone else's docket and is refused. A missing preamble line only warns
  (firms reformat preambles); `null` config skips the check.
- **`NON_TRADEMARK_REF`** (default `/^Y/`) drops references the firm uses for
  non-trademark matters (designs, copyrights); set to `null` to ingest all.
- **Unparseable due dates THROW.** Counsel's exact dates are the entire point
  of this feed — a date-format change must fail loudly, not silently wipe
  every deadline override.
- **Zero actions** parsed from a sheet that has data rows → throw
  (truncated or wrong-window export) unless `DOCKET_ALLOW_SHRINK=1`.

## Failure behavior — silent by design, and the alarm

Any throw lands in the resilience layer, which keeps serving the **previous
good parse** — `counselDocket` runs with `capMs: Infinity`, because a docket
report stays the truth until the next one arrives. So a bad report changes
nothing visible in the portfolio. That's the point, and the trap: the alarm
is the **Counsel Docket Inbox** row in Sync Health. `probeCounselDocket`
dry-runs the FULL path every 15 minutes — list, classify, download, parse,
validate — with an empty `prev` on purpose (a cached fingerprint would hide a
parse that no longer passes), and it hard-fails on stray .xlsx files the sync
merely warns about. A red row's Last Error names the guard that refused. An
empty (or all-unrecognizable) inbox also throws: that's a misconfiguration,
not an empty docket.

## How the join consumes it (`join.ts`)

- Resolved **first** and **strict-fatal when enabled**: a replace sweep built
  without the docket would delete the docket-only rows, and the delta's
  unchanged fingerprints would keep the deletion invisible afterwards.
- **Deadline overrides** (`docketDeadlineFor`): an action matches a row by
  the firm's reference (US rows carry `attorneyDocket`) or by office +
  canonical serial/registration identifier. The identifier path preserves
  A–Z/0–9, strips leading zeros only for purely numeric values, and REQUIRES
  an office because identifiers collide across registers. Earliest due date
  wins (e.g. an SOU plus its backup extension), and
  `docketActionType` maps counsel's action names onto the Deadline Type
  select, with "Docketed Action" as the generic fallback.
- **Lapse Instructed** comes from `LAPSE_STATUSES` (`ALLOW TO LAPSE`,
  `RENUNCIATION`) keyed by office + canonical identifier. It is strictly
  office-scoped: a `JP-12345` instruction cannot flag `WO-12345`; only an
  explicit WO entry flags the WO row. A lapse-instructed national designation
  keeps a docket-only row rather than promoting one country's instruction to
  the whole international registration.
- **Docket-only rows:** entries matching no registry row in the same office
  (and not a non-lapse designation of a known IR) become
  `DKT-{office}-{A|R}-{full normalized identifier}` rows. The A/R namespace
  prevents application-vs-registration collisions and preserved letters keep
  `AB123` distinct from `123`. Counsel's status is mapped to the buckets, the raw text kept in Office Status
  with a "(counsel docket)" suffix, and a 10-year renewal forecast that is
  filing-anniversary-based for EU-style offices (`FILING_BASED`) and
  registration-based elsewhere. Lapse-instructed rows get no forecast.

## Adapting to a different firm's export

Everything format-specific is a marked constant — change these, not the flow:

- `classifyReportName` patterns and the `reportDateFromName` date token.
- Properties: the required header names in `parsePropertiesReport`,
  `COUNTRY_TO_OFFICE` (counsel's country names → ST.3-style office codes —
  what lets a docket row join a TMview row; unmapped countries warn by
  name), `LAPSE_STATUSES`, `MIN_PORTFOLIO_ROWS`.
- Docket: the column names read in `parseDocketReport` (`Current Due Date`,
  `Reference #`, `Action Name`, `Country ID`, `Reg/Serial`, `Title`), the
  `Client:` preamble regex, `NON_TRADEMARK_REF`.
- `parseXlsxSheet` (`engine/xlsx.ts`) already renders date-styled cells as
  ISO `yyyy-mm-dd` — the parsers treat anything else as a format surprise;
  keep that contract.
- `test.ts` covers both parsers with grid fixtures — adapt the tests against
  a **sanitized** sample of the new format before pointing the worker at
  real reports, then bump `DERIVATION_VERSION` so cached parses re-run.

## Revert path

- **Unset `DOCKET_INBOX_PAGE_ID`** to stop ingesting — emptying the page
  alone just freezes the last parse (the empty-inbox throw keeps the
  previous snapshot serving).
- To drop the cached parse too: `ntn workers sync state reset portfolioDelta`.
- To remove the feature entirely: `sources.counselDocket = false` +
  redeploy (removes the Lapse Instructed column — a schema change, so run
  the backfill), and that backfill also sweeps the `DKT-` rows.
