# Worker custom block: Hello world

This is the smallest custom block in the cookbook. It renders "Hello world"
inside a Notion page and declares no data sources, so it is a useful starting
point for a new block.

## Quickstart

From the repository root:

```zsh
cd workers/templates/custom-blocks/custom
npm install
npm run check
ntn customblocks dev
```

Open http://localhost:9873 to preview the block in the custom blocks dev
shell — a mock Notion host that serves the block from this project. When it
looks right, deploy:

```zsh
ntn login
ntn workers deploy --name custom
```

Insert the deployed custom block into a Notion page. It renders immediately
because it does not need a database mapping.

## Local development

The dev shell (`ntn customblocks dev`, above) is the local test loop: it
builds the worker, serves the block with this project's Vite, and renders it
in a mock Notion host. Edit `blocks/hello-world/src/index.tsx` to change the
rendered content; edits hot-reload. Add data-source definitions to
`src/index.ts` when the block needs Notion data, then restart the dev shell
to pick up the new manifest and bind sample data.

## Project structure

```text
src/index.ts                 Worker definition and custom block ID
blocks/hello-world/
  src/index.tsx              React entry point
  src/index.css              Notion token-based styles
```

## Appearance defaults

The frontend imports Notion CSS variables and scrollbar colors. SDK initialization keeps the
iframe document in sync with the host's theme and contrast settings. `src/index.css` applies the
font, text color, background, and sizing defaults; edit it to use your own design.

Use these defaults when no design is specified. Preserve any design the user provides, and don't
restyle existing UI to match Notion unless asked.

This template requires an SDK release containing document token scope and `scrollbars.css`.

## Verification

```zsh
npm run check
npm test
npm run build
```
