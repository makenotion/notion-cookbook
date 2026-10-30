# MCP-only school smoke test — 2026-10-29

An independent agent received the runtime skill and fictional semester brief,
without baseline page IDs or grading criteria. It created a new private workspace
through Notion MCP. Existing semester pages were preserved. All content and layout
changes used MCP; UI was used only for inspection and navigation.

## Verified data and workflow

- Three course records and five assignments retain dates, states, weights, rooms
  and office hours. Course bodies contain useful explanations and suggested study
  questions; assignment bodies contain briefs and next steps.
- Reciprocal course relations and course-filtered views connect the records.
- Saved-view queries returned Upcoming 4, Calendar 5, Completed 1 and Undated 0.
  Upcoming is ordered October 30, November 2, November 3, November 6.
- Record full-width settings saved through the data-source layout capability.
- The rendered retest first screen shows the competitor-analysis priority,
  course navigation and all four Upcoming rows with due dates and status visible.
- The reviewer opened Marketing, inspected its study material and two related
  assignments, then opened Competitor analysis with pinned due/status and its
  substantive brief, and checked the home backlink.
- Completed showed the one submitted Wayfinding journal. The October Calendar
  showed dated entries; all five Calendar records were verified by MCP query,
  not all five visually inspected in the calendar.

## Revisions and acceptance

The first output included unnecessary design-research commentary. After preserving
that evidence, the runner applied revised reusable guidance through MCP to remove
it. Initial UI access was blocked by a hanging inspection call; subsequent native
inspection worked and identified excessive wrapping in the 25% reminder rail and
stacked course cards pushing assignment dates below the first screen.

The runner revised the reusable limited-width guidance before resuming the same
workspace through MCP. The resulting continuous layout puts a concise priority
and compact course navigation above the working assignment table, followed by
reminders and substantive course cards. All record and database IDs were retained.
The final rendered workflow passed the desktop checks above. This is a resumed
test after instruction changes, not an untouched first-pass success. The harness
also removed its test label from the page title as a separate cleanup.

Screenshots retained with the local run evidence are `home-retest.png` and
`assignment-retest.png`. Narrow-viewport behavior and browser zoom were not
measured. Do not interpret this desktop pass as narrow-screen verification or
pixel parity with a template reference.

## Capability limits and scope

Standalone home width/font and no-cover gallery sizing/property wrapping were not
exposed by the inspected tools. The COVER directive supports file-property card
sizing; that alternative was not exercised. A complex course-record layout failed
with a generic validation error; a simpler full-width layout succeeded, with
related work in inline filtered views. The revised home works at the available
width without requiring unsupported layout settings.

The earlier UI-assisted sample does not establish MCP-only parity. This smoke
test also does not establish reliability across different semester briefs.
