# Worker custom block: Org chart

**TL;DR:** A tree org chart rendered inside a Notion page from a People
database with a self-referencing "Reports to" relation. Cards show avatar,
name, and role; teams collapse; search jumps straight to a person.

## Quickstart

From the repository root:

```zsh
npm install --global ntn
cd workers/templates/custom-blocks/org-chart
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
ntn workers deploy --name org-chart
```

In Notion, insert the custom block into a page and map its `people` data
source to a database with the schema below. The block shows a sample org and a
setup hint until the data source is bound.

## Database

One data source, semantic key `people` ("People"):

| Property    | Type      | Meaning                                          |
| ----------- | --------- | ------------------------------------------------ |
| `name`      | title     | The person's name                                |
| `role`      | rich_text | Role line shown under the name                   |
| `reportsTo` | relation  | The person's manager (relation to this database) |

Reports are derived by inverting `reportsTo` across all rows — no reverse
relation property is required. People without a manager are roots; multiple
roots render side by side. Cycles, self-references, and manager pointers to
missing rows are broken gracefully and rendered as extra roots. Page icons are
used as avatars when present, with initials on a stable per-person tint
otherwise.

## Interactions

- **Collapse** a subtree with the count pill under a card; the toggled card
  stays anchored while the rest of the layout reflows.
- **Hover or select** a card to highlight its reporting chain to the root;
  selection adds a quiet footer line ("3 direct · 11 total").
- **Search** with the floating input (`/` focuses, `Esc` clears). Choosing a
  match expands collapsed ancestors and pans to the person.
- **Overview navigation:** below 90% zoom, clicking a card selects it and
  animates to 100% zoom centered on that person. At 90% and above, clicking a
  card toggles its selection.
- **Pan** by dragging, **zoom** with the wheel or the controls in ten steps
  (25–140%), and **zoom-to-fit** with the fit control.

The hosted block is full-bleed: its canvas fills the height supplied by the
host instead of reporting a fixed 520px height.

## Local development

Test the block in the custom blocks dev shell (`ntn customblocks dev`,
above), which renders it in a mock Notion host with sample data sources to
bind against, before any deploy.

The view also renders standalone with a seeded 12-person org, no Notion host
required:

```zsh
cd blocks/org-chart
npx vite
```

Open `http://localhost:5173/?mock=1`. Harness parameters: `theme=dark`, plus
scenario switches for `loading`, `unbound`, `empty`, `single`, `cycle`, and
`big` (121-person) datasets.

## Project structure

```text
src/
  index.ts       Worker definition and the people data-source schema
blocks/org-chart/
  src/
    OrgChart.tsx        Viewport, cards, connectors, search, selection
    tree.ts             Tidy-tree layout (Reingold–Tilford-style) and forest building
    useNotionPeople.ts  Real data layer (rows + lazy icon resolution)
    mockData.ts         Seeded orgs for standalone development
```

## Limitations

- Avatar resolution issues one `pages.get` per row (fine at org scale; rows
  cap at 999).
- Search matches name and role substrings only.
- Collapse state lives in the session; it isn't persisted to the block.
