# MCP-only school smoke test — 2026-10-29

An independent agent received the runtime skill and fictional semester brief,
without baseline page IDs or grading criteria. It created a new private workspace
through Notion MCP. Existing semester pages were preserved.

## Verified

- Three course records and five assignments retain dates, states, weights, rooms
  and office hours. Course bodies contain useful explanations and suggested study
  questions; assignment bodies contain briefs and next steps.
- Reciprocal course relations and course-filtered views connect the records.
- Saved-view queries returned Upcoming 4, Calendar 5, Completed 1 and Undated 0.
  Upcoming is ordered October 30, November 2, November 3, November 6.
- The saved home contains the priority/reminders column, course gallery and
  assignment views. A second MCP composition pass repaired reordered blocks.
- Record full-width settings saved through the data-source layout capability.

## Revision and limitations

The first output included unnecessary design-research commentary. After preserving
that evidence, the runner applied revised reusable guidance through MCP to remove
it. This is a resumed test, not an untouched first-pass success.

No UI mutations occurred. Browser inspection hung and was aborted; no screenshot
was obtained. First-screen density, wrapping, overflow, narrow-screen readability
and the rendered navigation walk remain unverified. **This is not a visual pass.**

Standalone home width/font and no-cover gallery sizing/property wrapping were not
exposed by the inspected tools. The COVER directive supports file-property card
sizing; that alternative was not exercised. A complex course-record layout failed
with a generic validation error; a simpler full-width layout succeeded, with
related work in inline filtered views.

The earlier UI-assisted sample does not establish MCP-only parity. This smoke
test also does not establish reliability across different semester briefs.
