---
name: custom-blocks
description: Comprehensive guide to building Notion worker custom blocks - use when the user wants to build interactive UI connected to Notion data.
user-invocable: false
---

## What a custom block is

`worker.customBlock()` declares a front-end web app that Notion serves in an iframe. It is a build-time/deploy-time capability with no `execute` handler, so it cannot be run with `ntn workers exec`. A custom block has two SDK surfaces: `@notionhq/workers` declares how the block is built and which data-source schemas it expects, while `@notionhq/custom-blocks` allows the the iframe frontend code to communicate with the Notion host at runtime.

Before scaffolding a custom block frontend, add `@notionhq/custom-blocks` to the worker's existing root `package.json`, add `@notionhq/custom-blocks-dev-shell` to its `devDependencies`, and install from the worker root. The block frontend shares that package and its `node_modules`. Do not create a second `package.json` inside the Vite app. Read the installed packages' READMEs and docs for the current client API.

Use the custom blocks dev shell to test locally:

```shell
ntn customblocks dev
```

This builds the worker, serves each block with the project's Vite server, and renders in a mock Notion host with sample data sources to bind.

See the README in `node_modules/@notionhq/custom-blocks-dev-shell` for information on data bindings and sample data.

## Block sources

A project source is the default. `path` points to a buildable project directory relative to the worker root. The deploy pipeline runs `npm run build` in that directory and serves its `dist` output by default:

```ts
worker.customBlock("issueBoard", {
  path: "./blocks/issue-board",
})
```

Use `command` and `output` to override those build defaults:

```ts
worker.customBlock("issueBoard", {
  path: "./blocks/issue-board",
  command: "npm run build-prod",
  output: "build",
})
```

Use a static source when the directory already contains browser assets that should be served as-is:

```ts
worker.customBlock("issueBoard", {
  type: "static",
  path: "./blocks/issue-board/dist",
})
```

## Data-source schemas

The optional `dataSources` field declares the schema a block expects. It does not bind the block to a concrete database. Schema keys and property keys are author-defined identifiers.

```ts
worker.customBlock("issueBoard", {
  path: "./blocks/issue-board",
  version: 1,
  dataSources: {
    issues: {
      name: "Issues",
      description: "The team's issues",
      icon: { type: "emoji", emoji: "🐛" },
      properties: {
        title: {
          name: "Title",
          type: "title",
        },
        status: {
          name: "Status",
          description: "Workflow state",
          type: "status",
        },
      },
    },
  },
})
```

Property types use Public API names such as `title`, `rich_text`, `number`, `select`, `multi_select`, `status`, `date`, `people`, `files`, `checkbox`, `url`, `email`, `phone_number`, `formula`, `relation`, and `rollup`.

At render time, the block maps its configured bindings to the matching `dataSources` keys. Read the example source above with `useDataSource("issues")` from `@notionhq/custom-blocks/react`.
