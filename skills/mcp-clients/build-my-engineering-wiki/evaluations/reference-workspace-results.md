# MCP-only engineering smoke test — 2026-10-29

An isolated agent used the runtime skill and a fictional release brief to create
six work records and three substantive technical documents. All writes used
Notion MCP; native-app interaction only inspected and navigated the output.

## Verified

- Four open and two completed work records; chart counts match the saved records:
  one each Blocked, Building, Review and Ready, plus two Done.
- Reciprocal work/document relations, proposal versus accepted/current maturity,
  useful technical bodies and source fidelity.
- Native-app walk: home → blocker → related spec → home, technical library and
  completed alternate view. Private badge visible.
- Summary/chart precedes native work/library tabs after the documented second
  composition pass. Existing IDs were reused.

## Improvement and retest

Initial rendering pushed Engineer offscreen. The reusable instructions were
changed to prioritize title, status and engineer in the primary work view at the
available width. The runner applied the change through MCP and visually confirmed
all four titles, statuses and engineers fit. Priority remains in record details
and continues to determine sorting. Initial screenshots were preserved.

This was a resumed test, not an untouched first-pass success. A relation DDL
validation error also led to a narrow instruction correction before retrying.

Standalone-home width/font, existing database title visibility and explicit table
widths were not exposed. These were not repaired through the UI. Inspection used
the existing desktop zoom; it was not independently measured as 100%. Narrow-screen
behavior was not tested. The demonstrated workflow and essential-column rendering
passed; this is not a claim of exact visual parity or broad reliability.
