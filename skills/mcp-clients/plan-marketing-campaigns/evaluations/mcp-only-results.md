# MCP-only marketing smoke test

Run date: 2026-10-29. Runtime baseline: `fc835f0` (Plan marketing campaigns).

## Method and fixture

An isolated agent received the runtime and a fictional Fieldnote Focus brief:
one November 12 launch campaign, six content drafts, and three brand resources.
The brief specified two reviews, two drafts, one blocked walkthrough video, and
one undated idea. Owners were unknown and publication dates tentative. The
fixture requested restrained green accents and no artwork.

All workspace writes used Notion MCP. Read-only desktop inspection used one
existing Notion Dev window. A preliminary run used the standard connection;
the delivered run was reproduced in Dev. Existing work was not modified.

The baseline allowed UI fallback, overridden by the explicit MCP-only task.
The first rendered home squeezed its next-action sentence into a quarter-width
rail, splitting a word and making the callout excessively tall. The guidance
was revised to place longer actions above the columns when page width cannot
be configured. The runner applied that correction through MCP to the same
workspace. This is a resumed correction, not an independent pass of the final
patched runtime, and not a cross-model reliability claim.

## Observed results

| Check              | Observation                                                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Campaign relations | All six content records related natively to the campaign; reciprocal relation read back.                                                                                                        |
| Campaign work view | Six rows, including the undated idea. Rendered titles, channels, status, and dates fit; long titles wrapped.                                                                                    |
| Attention queue    | Three records: two reviews and the blocked video.                                                                                                                                               |
| Unscheduled view   | One undated email idea; verified through both MCP and desktop navigation.                                                                                                                       |
| Working bodies     | Opened the article and video from the campaign. Article contained a substantive draft and editorial checks; video contained a timed shot list, voiceover, and explicit missing-footage blocker. |
| Record layout      | Operational properties visible near the title; additional details in the sidebar.                                                                                                               |
| Revised home       | Readable next action above the columns; compact navigation, campaign card, and attention queue remained usable.                                                                                 |

## Limits

Standalone page width/font and precise gallery card sizing were unavailable
through this connection. Record full width and pinned properties were supported.
The table-wrap setting was accepted but omitted from readback; desktop inspection
confirmed wrapping. No UI settings were used to repair the result.

The calendar configuration was read back but its rendered calendar was not
inspected. A second campaign was not created to test exclusion. Narrow-screen,
mobile, and normalized-zoom checks were not performed. No cover or original
artwork was exercised. This verifies the connected workflow and the observed
wrapping correction, not visual equivalence to every reference template.

The new narrow-home scenario is an evaluation specification, not an executed
independent test. A fresh run of the final runtime remains necessary before
claiming that it reproduces the corrected layout without intervention.
