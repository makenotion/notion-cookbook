# Worker custom block: Hello world

This is the smallest custom block in the cookbook. It renders "Hello world"
inside a Notion page and declares no data sources, so it is a useful starting
point for a new block.

## Quickstart

From the repository root:

```zsh
cd workers/custom-blocks/custom
npm install
npm run check
ntn login
ntn workers deploy --name custom
```

Insert the deployed custom block into a Notion page. It renders immediately
because it does not need a database mapping.

## Local development

Run the view with Vite:

```zsh
cd blocks/custom
npx vite
```

Edit `blocks/custom/src/index.tsx` to change the rendered content. Add
data-source definitions to `src/index.ts` when the block needs Notion data.

## Project structure

```text
src/index.ts                 Worker definition and custom block ID
blocks/custom/
  src/index.tsx              React entry point
  src/index.css              Notion token-based styles
```

## Verification

```zsh
npm run check
npm test
npm run build
```
