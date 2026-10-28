# Custom block design

Use Notion styling for a new project when the user hasn't specified a design, or when the user
explicitly asks for Notion styling. Otherwise, preserve the existing or supplied design.
For a behavior-only change, keep the existing layout, colors, and typography.

## Appearance setup

For Notion styling, import `@notionhq/custom-blocks/nds.css` and optionally
`@notionhq/custom-blocks/scrollbars.css`. The SDK follows the host's theme and contrast settings.
Apply the tokens in your own CSS to set fonts, colors, and spacing.

Keep a supplied design's styles and imports unless the requested change needs them.
The SDK's data and sizing APIs work with either design.

## Typography and color

For Notion styling, use `--font-sans` for interface text and `--font-mono` for code. Use
`--text-body` with `--text-body--line-height` for body text and `--text-title` with its line-height
and weight tokens for titles. Use `--font-weight-medium` or `--font-weight-semibold` for emphasis.

Font tokens define stacks, not font files. The sans stack starts with system UI fonts.
Bundle any additional licensed fonts the design needs.

Use `--content-primary` for main text, secondary and tertiary roles for supporting text,
`--bg-base` or `--bg-elevated` for surfaces, and `--border-primary` for boundaries.
Prefer semantic tokens over copied palette values. Pair status colors with labels or another visible cue.

## Layout and scrolling

Custom blocks share a Notion page with other content. Keep the main task clear at the available width.
With Notion styling, choose spacing
and radius tokens such as `--spacing-8`, `--spacing-16`, and `--radius-8` consistently.
Don't add decorative dashboards, navigation, or cards around content that doesn't need them.

Let layouts wrap at narrow widths. Prefer flexible grids and intrinsic sizing over fixed widths.
Use automatic block height for content that belongs in the page flow. Bound long lists, editors,
or canvases when an internal viewport helps the task. Avoid accidental nested scroll containers.

## Interaction and states

Use semantic controls with accessible names and visible focus. Support keyboard operation.
Use accessible primitives for menus and dialogs, including focus movement and return.
Represent loading, empty, error, and populated states. Explain errors and offer recovery.
Honor reduced-motion preferences. Keep useful content visible during refresh when possible.

## Review before finishing

Check narrow and wide widths, light and dark themes, high contrast, and keyboard operation.
Check empty and dense data, long labels, errors, and visible native scrollbars.
For a supplied design, check that the integration preserves its layout, palette, and typography.

See [Appearance and sizing](https://developers.notion.com/custom-blocks/sdk/appearance),
[Design tokens](https://developers.notion.com/custom-blocks/sdk/design-tokens), and
[Designing custom blocks](https://developers.notion.com/custom-blocks/guides/design) for details.
