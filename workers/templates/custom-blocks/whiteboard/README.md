<!-- Generated from workers/templates/custom-blocks/README.template.md. Run npm run agents:sync to update. -->

# Whiteboard custom block

Build your own interface inside Notion with this template.

## Prerequisites

- Node.js 22+ and npm 10+.
- The [Notion CLI (`ntn`)](https://developers.notion.com/cli/get-started/installation).
- A Notion workspace.

## Set up

pnpm is recommended for new projects; npm also works.

From this template’s directory, install dependencies:

```sh
pnpm install
```

## Deploy and share

Deploy the block to use it in Notion:

```sh
ntn login
ntn workers deploy --name whiteboard
```

Insert the deployed block into a Notion page. Share the page so others can
use the block.

Deploy again to publish later changes.

## Develop locally

Use the dev shell to verify changes locally with sample data before you deploy:

```sh
ntn workers customblocks dev
```

Open the shell URL printed by the command. See the documentation in
`@notionhq/custom-blocks-dev-shell` for more details.

## Agent instructions

Coding agents start from `AGENTS.md`. The full custom block guide ships in
`@notionhq/workers`, so updating that package updates the guidance.
