# Custom block design

Use these defaults when no design is specified. Preserve any design the user provides, and don't
restyle existing UI to match Notion unless asked. For a behavior-only change, keep the existing
layout, colors, and typography.

Custom blocks are browser apps inside a Notion iframe. Choose the design for the block's task
and available space. A chart, editor, or canvas may need a different composition from a list.

## Appearance setup

When using Notion's visual defaults, import `@notionhq/custom-blocks/nds.css` and optionally
`@notionhq/custom-blocks/scrollbars.css`. SDK initialization synchronizes the document's token
scope, theme, contrast, and native control appearance. Tokens define values; your CSS applies them.
Keep imports and styles already used by a supplied design unless the requested change needs them.

For React, mount inside `NotionCustomBlock`. `NotionTokenScope` is available for explicit nested
scopes, but document tokens also cover portals. For other frameworks, await `initCustomBlock()`.
Use the SDK's sizing and data APIs with either Notion styling or a supplied design.

## Typography and color

For Notion styling, use `--font-sans` for interface text and `--font-mono` for code. Use
`--text-body` with `--text-body--line-height` for body text and `--text-title` with its line-height
and weight tokens for titles. Use `--font-weight-medium` or `--font-weight-semibold` for emphasis.

Font tokens describe stacks; they don't bundle font files. The sans stack starts with system UI
fonts. Serif and monospace stacks use available local fallbacks. Bundle additional licensed font
assets when a supplied design requires them.

Use `--content-primary` for main text, secondary and tertiary roles for supporting text,
`--bg-base` or `--bg-elevated` for surfaces, and `--border-primary` for boundaries.
Prefer semantic tokens over copied palette values when following Notion's design. Pair status
colors with labels or another visible cue. Don't replace a supplied brand palette with these roles.

## Layout and scrolling

Use a clear hierarchy and enough spacing to separate tasks. With Notion styling, choose spacing
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
