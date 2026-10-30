# MCP-only project smoke test — 2026-10-29

An isolated agent used the fictional project brief and revised runtime skill to
create a private portfolio with two Projects records and shared Tasks, Docs and
Meetings databases. All writes used Notion MCP. Existing pages were preserved.

## Verified

- Seven tasks retain supplied states, dates and fictional owner names as text;
  the second project's task remains undated.
- Three substantive documents distinguish accepted decisions from proposals.
- Two dated weekly agendas plus reusable weekly-review and async-standup formats.
  These are ordinary records, not scheduled recurring templates or past minutes.
- Exact filters: main project five open, six total, one completed; second project
  one undated task. Three docs, one review item and four meeting/format records.
- Related project/doc links and native tabs containing inline work views.
- Portfolio gallery precedes shared collection links in saved content.

## Iteration and gaps

Mixed pinned Status/text Lead/Target properties were rejected with a validation
error. Ordered visible native properties and a full-width record layout succeeded;
the reusable instructions now support that fallback. Initial output was preserved
before retries. The final result is a resumed test, not a first-pass success.

A native-app inspection call stalled and was aborted without returning a screen.
No UI mutations occurred. Rendered first-screen hierarchy, visible properties,
column readability and the navigation walk remain unverified. **This is not a
visual pass.** MCP readback alone does not establish visual quality.
