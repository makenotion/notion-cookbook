# Worker custom block: Whiteboard

**TL;DR:** A freeform whiteboard rendered inside a Notion page — sticky notes,
pen, lines, and arrows on a dot-grid canvas. Every object on the board is a row
in a regular Notion database, so a sketch is as durable (and as queryable) as
any other page data.

## Quickstart

From the repository root:

```zsh
npm install --global ntn
cd workers/templates/custom-blocks/whiteboard
npm install
npm run check
npm test
ntn customblocks dev
```

Open http://localhost:9873 to preview the block in the custom blocks dev
shell — a mock Notion host with sample data sources to bind. When it looks
right, deploy:

```zsh
ntn login
ntn workers deploy --name whiteboard
```

In Notion, insert the custom block into a page and map its `items` data source
to a database with the schema below (or let block configuration create it).
The block shows a setup hint until the data source is bound.

## Database

One data source, semantic key `items` ("Whiteboard items"). Each canvas object
is one row:

| Property          | Type      | Meaning                                                                                |
| ----------------- | --------- | -------------------------------------------------------------------------------------- |
| `title`           | title     | Sticky text, or an auto label for strokes and arrows                                   |
| `type`            | select    | `sticky`, `stroke`, `line`, or `arrow`                                                 |
| `color`           | select    | `yellow`, `blue`, `pink`, `green`, `purple`, `red`, `gray`                             |
| `x`, `y`          | number    | Canvas position                                                                        |
| `width`, `height` | number    | Bounding box (sticky size for notes)                                                   |
| `strokeWidth`     | number    | Ink width for strokes, lines, and arrows                                               |
| `z`               | number    | Stacking order                                                                         |
| `points`          | rich_text | JSON point array relative to `x`/`y`, chunked under the 2000-character rich-text limit |

Rows stay synchronized through `useDataSource` (limit 999). Writes are
optimistic: creates and deletes go out eagerly, moves and edits are debounced
~500ms, and failed writes revert quietly from a persisted baseline.

## Tools and shortcuts

Select (`V`), Hand (`H`), Pen (`P`), Eraser (`E`), Sticky (`S`), Line (`L`),
Arrow (`A`). Pan with the Hand tool, Space-drag, middle-drag, or a two-finger
trackpad gesture. The canvas is bounded to 2400×1600 pixels. The options row
above the toolbar switches with the tool:
ink swatches and S/M/L widths for pen/line/arrow, fill swatches for stickies,
three radii for the eraser. Selecting an existing item opens the same property
controls, and selected stickies include an explicit text-edit action. Sticky
text is left-aligned in both display and edit modes. `Delete` removes the
selection, `Esc` returns to Select, arrow keys nudge (Shift = 10px), `Enter`
edits a selected sticky, and Shift snaps lines and arrows to 45°.

## Local development

Test the block in the custom blocks dev shell (`ntn customblocks dev`,
above), which renders it in a mock Notion host with sample data sources to
bind against, before any deploy.

The view also renders standalone with seeded sample data, no Notion host
required:

```zsh
cd blocks/whiteboard
npx vite
```

Open `http://localhost:5173/?mock=1`. Harness parameters: `theme=dark`,
`empty=1`, `loading=1`, `unbound=1`, `schema=1`.

## Project structure

```text
src/
  index.ts       Worker definition and the items data-source schema
blocks/whiteboard/
  src/
    App.tsx      Canvas, tools, selection, and pointer handling
    Toolbar.tsx  Floating tool pill and contextual options row
    model.ts     Item model and (de)serialization
    geometry.ts  Stroke smoothing, hit testing, arrowheads
    notionStore.ts / mockStore.ts   Real and mock data layers
```

## Limitations

- No resize handles, multi-select, or undo; stickies are fixed at 160×160.
