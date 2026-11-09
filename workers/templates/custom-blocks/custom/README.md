<!-- Generated from workers/templates/custom-blocks/README.template.md. Run npm run agents:sync to update. -->

# Hello world custom block

A starting point for building your own interface inside Notion.

Develop locally with sample data, preview inside Notion with workspace
data, or deploy the block to use and share it.

## Prerequisites

- Node.js 22 or later and npm 10 or later.
- The [Notion CLI (`ntn`)](https://developers.notion.com/cli/get-started/installation).
- A Notion workspace.

## Set up

Install dependencies and check that the project is ready to develop.
Run these commands from this template’s directory:

```sh
npm install
npm run check
```

## Develop locally

Iterate on your UI with sample data and hot reload in the dev shell.

```sh
ntn workers customblocks dev -- --json
```

Open the shell URL printed by the command. Follow the SDK’s local
development guide for details.

## Preview inside Notion

Use in-app preview to test local UI changes against production data
before deploying them. Preview writes still change real workspace data.

Follow the SDK’s local development guide to connect your block.

## Deploy and share

Publish your block so you and your teammates can use it in Notion
without running a local server.

```sh
ntn login
ntn workers deploy --name custom
```

Insert the deployed block into a Notion page and share the page.
Deploy again to publish later changes.
