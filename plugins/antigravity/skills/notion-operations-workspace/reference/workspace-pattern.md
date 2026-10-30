# A maintained team guide and request desk

Use a library-first organization: guidance records carry ownership and review
state, while requests carry execution status and dates. Make the maintenance table
useful without making employees navigate an operator dashboard.

## First screen and separate jobs

For a handbook plus requests, use a readable home with a concise purpose and
three or fewer intent-based routes, such as joining, buying, and delivering.
Muted colored panels and matching semantic icons can make these routes legible;
each ends in an existing, complete procedure. Keep the proposed-guidance label
brief; put detailed source and sample qualifications in a collapsed note or on
the relevant record rather than between navigation and the working library. Do not add decorative panels when
the brief is chiefly a tracking queue: put the working table first in that case.

Use native page tabs or distinct child destinations for Browse guidance, All
policies, and Request desk. A guidance gallery can show title, area, when to use,
and review state; All policies is a table for maintaining ownership and reviews.
Request desk defaults to open requests and has a completed view. Show title,
status, coordinator and due date; keep lengthy next-step detail in the record
when it would push key fields offscreen. Keep unassigned and undated items visible.

## Depth

Guidance records expose steward and review state and explain inputs, ordered
steps, exceptions, and completion. Requests describe the actual need, current
blocker/next action, and relevant procedure. Do not present proposed procedures
as company policy or infer that a recent edit constitutes a review.
Keep procedural guidance and its executions as distinct records. Reuse native
relations where the library and request queue should stay connected.

## Acceptance walk

Test both audiences: an employee reaches the right instructions from a plain
language route; an operator opens a request and sees who acts next. Verify open
and completed filters, procedure links, status colors, and readable columns.
Check that the working table exposes ownership, status and dates. Maintenance information must be visible, not buried in prose.

## Render and inspect the saved result

Build records and views first, then compose their existing blocks into the home.
Read the connection's current Markdown and view/layout documentation. On Notion
Dev MCP, relation DDL targets use the bare data-source UUID; creation parents use
the fetched collection URL. A full composition replacement uses `new_str`, not
`content`. Inspect after a rejected write before retrying. For native
toggles and tabs, separate their label from child blocks with a blank line.
Preserve exact child-page/database tags during edits. A tool's success response
does not establish that moved blocks retained the intended order: inspect the
saved page and correct misplaced sections while preserving existing objects.
If moving existing database blocks into a new tab/column container changes sibling
order, fetch the saved hierarchy, then reapply the intended complete composition
using those same object IDs. Verify the second readback before deciding the native
layout is unavailable; do not discard working tabs merely because their first
move reordered the page.

Set width, card size, wrapped content and property visibility deliberately.
Check data-source update capabilities for database-record layouts, not just page
update capabilities. On connections exposing `page_layout`, read
`notion://docs/database-page-layouts`: pinned properties, sidebar details and
record full width can be configured there before UI inspection. All workspace content and settings mutations must use the connected Notion MCP. UI use is
read-only inspection. If MCP lacks a setting, leave it unchanged and disclose the
precise missing capability; never silently rescue the layout through UI actions. Hide duplicate linked-database titles when MCP exposes that setting.
A tab intended as a working table must contain an inline database/view, not merely
a link to its full-page source. In Notion Markdown, verify `inline="true"` for
embedded work surfaces; reserve `inline="false"` for navigation destinations.
Use semantic colored page icons so mentions are recognizable, not a repeated
colored dot. Keep original assets and long detail accessible without dominating
the working first screen.

Verify home → record → related work → home, actual view filters and counts, and
at least one alternate view. Set an everyday default view through MCP when supported; disclose if that setting
is unavailable. Read-only UI inspection must not change the saved default. Inspect the rendered result at normal zoom with the
sidebar visible. Compare hierarchy, density and navigation against the selected
reference. Check useful work is visible above the fold, long titles wrap, and
essential columns do not overflow. Correct failures before delivery. If rendering
or a capability is unavailable, report that exact gap without claiming parity.

During skill evaluation, preserve the first result and the run's evidence. If
review finds a miss, change the reusable instructions and rerun or resume the
skill with only that revised guidance. Reviewer hand-polishing is not a passing
skill test. Equivalent layout and workflow matter more than identical wording,
page IDs, image pixels, or arbitrary record counts.
