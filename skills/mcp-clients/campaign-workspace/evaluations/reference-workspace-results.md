# Reference workspace smoke test (UI-assisted)

Run on October 29, 2026 against Notion Dev using the fictional brief in
`reference-workspace.json`. A fresh runner received the runtime skill and brief,
without conversation history, reference workspace IDs or grading criteria.

This run is not a passing MCP-only skill result. Home full width and cover
placement used the native UI; screenshots do not establish MCP-only visual parity.

## Observed result

- Three campaigns, six populated deliverables and a substantive Brand kit.
- Native campaign/content relations; exact campaign-view counts of 4, 1 and 1.
  The first campaign includes the undated founder note. Unscheduled returns one
  record; editorial review returns three.
- Distinct article draft, timed video storyboard and email subject/body. Unknown
  trial links, approvals, performance and footage were not invented.
- Home uses an asymmetric action rail and three illustrated campaign cards.
  Original cover and campaign title treatments are attached and render in Notion.
- Native campaign and content layouts expose pinned operational properties,
  keeping secondary details separate from working drafts.

At normal desktop zoom with the sidebar visible, the campaign states and next
editorial action are visible on the first screen. The full review queue is below
the fold. Home, campaign, article, email, shared Content's Unscheduled view and
Brand kit were visually inspected. Campaign scope and wrapped titles were checked
in the rendered four-row deliverable table.

## Instruction revisions during the test

The first result omitted welcomed creative and deferred native record layouts
without inspecting data-source layout capabilities. The reusable instructions
were revised; the same isolated runner resumed the existing output using them.
The reviewer did not directly polish the generated pages. The runner completed
home width and cover placement through the native UI. The SVG upload succeeded,
but assigning its `file-upload://…` reference to the page cover through MCP failed.
No alternative MCP cover method was tested. Campaign gallery previews and
database-record layouts were configured through MCP.

The final instructions also require restoring the intended everyday view after
checking alternates. This is part of delivery, not a new content transformation.

## Scope of confidence

This is a UI-assisted desktop smoke test with resumed instruction corrections,
not an untouched first-attempt pass or validation of the current MCP-only workflow. A new independent run of the
final corrected version, narrow/mobile rendering, comparative no-skill tests and
cross-model reliability remain unmeasured. Screenshot evidence and private
workspace links are retained locally rather than committed to the public repo.
