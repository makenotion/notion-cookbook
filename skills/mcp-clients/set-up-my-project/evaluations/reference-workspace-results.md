# MCP-only project smoke test — 2026-10-29

An isolated agent used the fictional project brief and revised runtime skill to
create a private portfolio with two Projects records and shared Tasks, Docs and
Meetings databases. All writes used Notion MCP. Existing unrelated pages were
preserved. The final result is a resumed test, not a first-pass success.

## Verified through MCP

- Seven tasks retain supplied states, dates and fictional owner names as text;
  the second project's task remains undated.
- Three substantive documents distinguish accepted decisions from proposals.
- Two dated weekly agendas plus reusable weekly-review and async-standup formats.
  These are ordinary records, not scheduled recurring templates or past minutes.
- Exact filters: main project five open, six total, one completed; second project
  one undated task. Three docs, one review item and four meeting/format records.
- Related project/doc links and native tabs containing inline work views.
- Native Status-only pinning succeeded, followed by Status-plus-Target pinning.
  Final layout pins Status and Target. The properties module is in the sidebar
  with Lead, Outcome and Summary hidden; lead and outcome remain in the body.
- Portfolio cards show short faithful summaries instead of the clipped full
  outcome. The source outcome is preserved. Parent title is Atlas · Projects.

## Visual inspection and iteration

The initial native-app call stalled and was aborted after 804.3 seconds without
returning state. The parent evaluator later obtained a working UI and visually
inspected the initial portfolio and project first screen. Milestone/team layout
was useful, but duplicate outcome and tall vertical properties pushed the working
tabs down, and the portfolio outcome text clipped.

The runner revised reusable guidance before applying corrections through MCP to
the same records: keep the full outcome once near the top, use a short card
summary when needed, and test a smaller supported pinning subset before declaring
all pinning unsupported. The initial mixed Status/Lead/Target pinning request had
failed; its validation error did not identify the cause. The successful Status
and Target trials supersede the earlier blanket pinning limitation. Lead remained visible in the intermediate layout; the final layout below moves
secondary properties out of the main reading flow.

A later screenshot/reconnection timeout temporarily interrupted the retest. UI
subsequently recovered and the final desktop workflow was inspected as recorded
below. MCP reads alone were not treated as visual evidence.

## Harness and evidence

Initial output and raw read/query results were preserved before retries. Raw
pinning requests/results and the original validation error were saved locally.
The private parent naming cleanup and corresponding brief destination change
remove test labels from the product; these are harness corrections, separate
from reusable skill behavior. No UI mutations were used by the runner.

## Subsequent rendered check and compact-layout correction

The parent recovered UI and verified portfolio cards with full titles, short
summaries, status and dates. Status/Target pins rendered successfully on the full
project page, but the remaining Lead properties section consumed excessive space
and left work tabs below the fold. Guidance was revised again before MCP writes.

Omitting the properties module entirely failed with INVALID_ARGUMENT. Moving it
to the documented sidebar and hiding Lead/Outcome/Summary succeeded. This keeps
Status/Target native pins and the explicit project lead in Team while removing
the main properties section. The original mixed-pin failure cannot be attributed
to the Lead type: that original request also omitted a properties module.
Raw errors and successful requests are saved. The final rendered check below
covers this sidebar correction and task/doc/meeting navigation.

## Final desktop workflow pass

The parent evaluator completed the final desktop walk. Portfolio cards show two
projects with full titles, status, dates and short summaries that fit. The project
first screen shows pinned Status/Target, a single outcome, pilot/risk and team;
the properties module is out of the main reading flow. Task tabs and the table
header reach the bottom edge of the first screen; actual task rows require
scrolling. This is not a claim that tasks are visible above the fold.

After scrolling, all five open tasks display full Name, Status, Owner and Due
columns without clipping. The evaluator opened the blocked task, followed its
body link to the accepted decision and inspected substantive detail. On returning,
Meetings displayed all four prepared/reusable records; the Nov 2 agenda contained
a useful timed agenda, pre-read and task links. This is a desktop workflow pass
for the resumed output. No zoom-change or narrow-screen pass was performed.
Parent screenshots are saved as portfolio-retest and home-retest in temporary
evidence. No further page changes were made after this verification.
