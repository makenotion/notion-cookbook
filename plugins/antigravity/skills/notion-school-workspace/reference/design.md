# Design for a useful, beautiful starting point

Read this before composing or polishing the output. Treat the layouts as starting
points; adapt them to the user's content and supported Notion features.

## Gallery observations

Inspected gallery preview images and visible creator labels on October 29, 2026.
This is a deliberately varied sample, not an audit of the entire gallery or proof
that every interaction in the underlying templates works.

| Template and creator                                                                                     | Visible design pattern                                                             | Adaptation worth borrowing                                                                                           |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [Brand Guidelines — Notion](https://www.notion.com/templates/brand-guidelines)                           | Small purple bookmark icon, clear introduction, section headings and dividers.     | Establish a quiet hierarchy and explain how to use the page before detailed reference material.                      |
| [Brand Assets — Notion](https://www.notion.com/templates/brand-assets)                                   | Large asset previews, short labels, category view tabs, and a brief usage hint.    | Use imagery when users recognize items visually; give views meaningful names and show only useful metadata.          |
| [Team home — Notion](https://www.notion.com/templates/team-home-v4)                                      | Office-photo cover, home icon, team overview and a concise mission statement.      | Give the home an identity and purpose before organizational detail.                                                  |
| [Brand Guide — Matt Bio](https://www.notion.com/templates/brand-guide-bio)                               | High-contrast typographic cover, compact index, and coordinated green logo panels. | Carry a coherent palette through supplied assets and navigation; use an index for long reference pages.              |
| [Notion Engineering Dashboard — Matt Bio](https://www.notion.com/templates/notion-engineering-dashboard) | Gradient cover, prominent action row, schedule with week/month tabs.               | Put frequent actions within reach and offer focused views rather than exposing everything at once.                   |
| [Student dashboard — Janice Studies](https://www.notion.com/templates/student-dashboard)                 | Soft photographic cover, playful icon, and a personal widget row.                  | Personal style can make a workspace inviting; retain warmth while giving actual academic work priority over widgets. |
| [Projects & Tasks — Notion](https://www.notion.com/templates/notion-projects-and-tasks)                  | Short explanatory intro, named view tabs, grouped tasks, and labeled status chips. | Pair orientation with a usable work surface; adapt the visible property count to the user's task.                    |

These are observations of previews; the implementation choices below are our
recommendations. Borrow composition and interaction patterns, not the creators'
artwork, example brands, paid content, or invented data. Record the actual creator
when citing a reference. Community and Notion-created templates are both eligible
unless the user explicitly narrows the source set.

## Calm study home

Suggested reading order: Course or semester title → next academic action → upcoming work and undated queue → course navigation → notes library.

Use consistent course icons or a muted subject palette. Course cards can be useful navigation, but lecture notes usually scan better as a compact list grouped by course. A cozy cover is appropriate if requested; clocks and quotes should not displace assignments.

## Compose before decorating

Choose a visual direction from the user's preferences and supplied brand or
personal assets: calm and minimal, warm and personal, or bold and editorial.
When no preference is given, use a calm native Notion layout with one restrained
accent. Do not stop for a style questionnaire. Carry the same direction across
the home and child pages; preserve an existing workspace's visual language.

1. **First screen:** show the page identity, its purpose, and a useful next action
   or entry to active work. Keep covers modest enough that these remain easy to
   reach. A title and coherent icon can provide identity without an image.
2. **Navigation:** expose a small set of frequently used destinations with short,
   specific names. Put secondary links under a labeled group or toggle. Make
   labels correspond to their targets; do not fabricate buttons as plain text.
3. **Primary work surface:** choose a list for scanning, a table for comparison,
   a board for stages, a calendar for dated work, or a gallery for visual assets.
   The homepage does not need all five. Name views after the question they answer,
   such as “Needs review” or “Upcoming,” and verify the filter behind the name.
4. **Rhythm:** repeat heading levels, spacing, icon style, and card metadata.
   Separate major sections with whitespace or a divider; avoid nested callout
   boxes and differently colored headings competing for attention. Reserve a
   prominent callout for the most useful instruction, exception, or next step.
5. **Depth:** keep the home concise and put long detail on child pages, with a
   clear route back. Each repeated record type should use a consistent body
   structure so opening the next item feels familiar.

Use native Notion colors, icons, callouts, columns, covers, and database layouts
only where exposed by the connection. Prefer one accent family plus semantic
status colors as a default, not a fixed palette that overrides user taste.
Use text labels alongside color, legible contrast, and descriptive image captions
or alt text where supported. Do not simulate custom typography with Unicode letters.

An image should establish identity, explain something, or help recognize an item.
Use supplied or appropriately licensed assets, or original assets when requested.
If none fit, omit the cover instead of copying a preview image. Preserve image
meaning under cropping. Avoid automatic third-party clock, quote, or weather
embeds; a reference containing widgets is not a reason to add them to every home.

Keep wide task tables out of narrow side columns. On smaller screens, the reading
order should remain purpose → action → work → reference. Essential tasks, blockers,
and navigation must not depend on a desktop-only arrangement. Use a single-column
fallback when columns are unavailable. A plain link can replace an unsupported
action button; a simple list can replace a gallery without pretending to be one.

## Finish with a usability pass

- Can a new user tell what this page is for and where to begin without reading
  the whole page? Move or shorten the introduction if not.
- Can they find a relevant item, open its detail, and return home? Check the real
  destinations and filters. Test supported navigation with read-only actions;
  verify create-action configuration without creating dummy work.
- Do cards or rows show enough to act without exposing every property? Remove
  duplicate metadata and avoid repeated full-database sections.
- Do empty sections provide an honest next step, such as adding the first course,
  rather than fake records or a misleading “all caught up” message?
- Are undated, blocked, and unassigned items still discoverable after polishing?
  Do not make a page appear tidier by hiding unresolved work.
- If a rendered preview is available, inspect the top and the main work area on
  desktop and a narrow viewport. Fix clipping, awkward wraps, excessive cover
  height, poor contrast, or broken navigation before finishing. Otherwise report
  structural checks separately from the unperformed visual check.

A page does not pass because it has a cover or enough icons. It passes when its
identity is coherent, its information is easy to scan, and its first action works.
