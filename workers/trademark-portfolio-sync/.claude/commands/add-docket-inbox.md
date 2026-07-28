---
description: Enable the Docket Inbox — ingest counsel's docket and properties reports from a Notion page
---

The user wants the counsel-docket source: exact docketed deadlines that
override the computed estimates, lapse instructions the registers can't know,
and rows for direct national filings no registry API enumerates. **Read the
`docket-inbox` skill first** — it documents the two report kinds, the
newest-file election, the full guard set, and every customization constant.
Then walk these steps with the user:

## 1. Confirm the ingredients

- Outside counsel (or a docketing system) that can export **two .xlsx
  reports**: a docket report (upcoming statutory deadlines) and a properties
  report (every mark in the portfolio). Most docketing systems export these
  natively.
- A Notion **internal integration** and its token — they can create one at
  https://www.notion.so/profile/integrations if they don't have one.

## 2. Create the inbox page

Any Notion page works (suggest titling it "Docket Inbox"). Share it with the
integration: page → `⋯` → Connections → add the integration. **A page move
can silently drop that access** — the health probe will catch it, but tell
the user not to relocate the page casually. Copy the page URL.

## 3. Environment

Add to `.env` and push to the deployed worker (`ntn workers env push --yes`,
or `ntn workers env set KEY=value`):

- `DOCKET_INBOX_PAGE_ID` — the page URL or ID (both accepted).
- `NOTION_API_TOKEN` — the integration token. (Connect the integration to the
  portfolio database too if they'll use `refreshMarkImages` later.)

Both are read at run time, so env changes need no redeploy.

## 4. Config, deploy, migrate

In `src/config.ts` set `sources.counselDocket = true`, and set
`docketClientNumber` to their client number at the firm **exactly as the
docket report's criteria block prints it** (e.g. `Client: 123456` →
`"123456"`) — the ingester refuses a report exported for a different client;
`null` skips that guard. Config is compile-time and the toggle adds the
**Lapse Instructed** column, so: `ntn workers deploy`, then
`ntn workers sync trigger portfolioBackfill` — **backfill before delta**,
it's a schema change.

## 5. Ask counsel for the reports

Send something like this (keep it generic — any docketing system can do it):

> Could you send us, monthly as .xlsx attachments: (1) a **docket report** of
> upcoming statutory deadlines across our trademark portfolio, with your
> docketed due dates; and (2) a **properties report** of all our marks — mark
> name, country, application/registration numbers and dates, status, classes,
> and owner of record. Your system's standard exports are perfect; please
> keep the report type and date in the filenames.

## 6. Drop the files

Drag both .xlsx files onto the inbox page. Classification is by filename —
they must include "Docket Report" / "Properties" (widen `classifyReportName`
in `src/sources/counsel-docket.ts` if the firm's naming differs), and the
`MMDDYYYY` date token in the filename is what elects the newest report, so
keep it.

## 7. Verify

- **Sync Health** grows a **Counsel Docket Inbox** row that turns "Up". The
  probe dry-runs the full download → parse → validate path every 15 minutes;
  a red row's Last Error names the guard that refused.
- `ntn workers exec portfolioBackfill --local` logs
  `[counselDocket] ingested N entries…` and `[join] N counsel-only rows`, and
  the emitted rows show `DKT-…` IDs, counsel's exact dates in **Next
  Deadline** (type "Docketed Action" where nothing statutory matches), and
  **Lapse Instructed** checks.
- After the deployed backfill, spot-check one mark counsel dockets: its
  deadline should be counsel's date, not the computed estimate.

## 8. Ongoing

Each month someone drags the new reports onto the page — nothing else. Stale
attachments can stay (the filename date wins), but deleting them keeps the
election obvious. If ingestion refuses a legitimate file (a genuinely shrunk
portfolio, an intentionally empty docket window), set `DOCKET_ALLOW_SHRINK=1`
for one cycle and **unset it after**. If the firm's export format doesn't
match the parsers, follow the `docket-inbox` skill's "Adapting" section — the
column names, country map, and reference-prefix rule are all marked constants
with tests.
