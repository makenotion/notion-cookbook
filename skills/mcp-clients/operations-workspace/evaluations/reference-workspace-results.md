# MCP-only operations smoke test — 2026-10-29

An isolated agent used the runtime skill and fictional team brief to create a new
private handbook and request desk. All workspace writes used Notion MCP.

Verified four complete procedures and four requests, reciprocal relations, and
saved-view counts of four guidance records, three open requests and one completed
request. The saved home places intent-based routes before native guidance/request
tabs containing real inline databases. Procedure bodies explain inputs, steps,
exceptions and completion; requests link to applicable guidance. No unsupported
policy threshold or real person assignment was invented.

Tool-contract errors were corrected before retrying: relation targets need bare
data-source UUIDs for this connection, and composition replacement uses new_str.
The instructions require MCP-only writes and precise capability disclosure.

## Visual findings and instruction-led revisions

Initial inspection found long route descriptions, a library below the first
screen, and clipped essential fields. The skill was revised before each MCP
change. Compact intent headings, restrained background colors and direct links
replaced the tall directory; detailed procedure content remained on records.
The parent visually verified the compact colored home and native navigation from
request to related procedure and back home.

The evaluator's long test title was separately changed to `Juniper · Team guide`.
That was a harness correction, not evidence of skill improvement.

The library was then reduced to Procedure, Steward and Review so secondary Area
metadata would not displace review state. The request table clipped Due; a native
compact list was added with all four essential fields, preserving the original
table as an alternate. The parent subsequently verified both revisions at the inspected desktop width:
all four library titles, stewards and full review labels fit, and all three open
request titles, statuses, coordinators and full due dates fit clearly.

Actual saved-view readback confirmed:

```json
{
  "library": {
    "type": "table",
    "displayProperties": ["Procedure", "Steward", "Review"],
    "sorts": [{ "direction": "ascending", "property": "Area" }]
  },
  "compactRequests": {
    "type": "list",
    "displayProperties": ["Request", "Status", "Coordinator", "Due"],
    "filter": "Status != Done",
    "sort": "Due ascending",
    "queriedRows": 3,
    "has_more": false
  }
}
```

## Remaining limits

Earlier visual retesting was interrupted by screenshot/reconnect timeouts. After
UI recovery, the parent completed the library and compact-list checks above.
No narrow-viewport claim is made.

After the list passed, the reusable instruction was extended to promote a fitting
list without duplicating records. MCP created a linked list as the first work
surface inside Request desk, with a Completed list tab; the original database
remains a full-page alternate. Saved hierarchy confirms this placement, and view
queries confirm three open and one completed record. The parent then inspected the promoted block: all three open rows fit, and the
Completed tab showed Contractor access closed with its owner and October 28 date.
No UI settings mutation occurred.

Standalone home full-width, existing database title visibility and saved-default
selection were absent from the inspected MCP controls. No UI settings rescue
occurred. This single-brief smoke test does not establish visual parity or reliability
across briefs. The desktop workflow checks passed after the documented revisions.
