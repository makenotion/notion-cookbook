# Notion API examples

Local TypeScript recipes built directly with the
[Notion API](https://developers.notion.com/reference) and the official
[JavaScript SDK](https://github.com/makenotion/notion-sdk-js). Each direct child
of this directory is a self-contained project with its own dependencies,
configuration, and README.

## Choose an example

### Learn the API

| Example                                                           | What it demonstrates                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Introduction to the Notion API](intro-to-notion-api/)            | A progressive tour of blocks, pages, databases, queries, templates, and file uploads. Start here. |
| [Parse text from any block type](parse-text-from-any-block-type/) | Recursively retrieve page content and extract available plain text from different block shapes.   |
| [Query large data sources](query-large-data-sources/)             | Read beyond the 10,000-row per-query limit by splitting work into `created_time` windows.         |

### Build integrations and apps

| Example                                                   | What it demonstrates                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [Database email update](database-email-update/)           | Poll a database for status changes and send notifications through SendGrid.            |
| [Generate random data](generate-random-data/)             | Inspect a database schema and create correctly typed sample rows.                      |
| [Notion–GitHub issue sync](notion-github-sync/)           | Copy issues from one GitHub repository into a Notion database.                         |
| [Notion task–GitHub PR sync](notion-task-github-pr-sync/) | Update Notion tasks when a linked GitHub pull request closes or merges.                |
| [Web form with Express](web-form-with-express/)           | Use an Express app and browser forms to create databases, pages, blocks, and comments. |

## General setup

Use the selected example's README as the source of truth. The common flow is:

1. Install the Node.js version required by its `package.json`.
2. Create a [Notion integration](https://www.notion.com/my-integrations).
3. Share the page or database used by the example with that integration.
4. From the example directory, run `npm install`.
5. Copy its environment template to `.env` when one is provided and add the
   required values.
6. Run the exact package script documented by the example.

The examples do not all use the same environment-template filename or run
script. Do not assume `npm start`; inspect the README and `package.json` first.

## A known-good first run

```sh
cd examples/intro-to-notion-api
npm install
cp .env.example .env
# Add NOTION_API_KEY and NOTION_PAGE_ID to .env
npm run basic:1
```

## Adapting an example

Keep the original project runnable while you work:

1. Read its README, `package.json`, and TypeScript entrypoint.
2. Identify the smallest API call or transformation that needs to change.
3. Preserve environment-variable names unless the new behavior needs a new
   value; document every new variable.
4. Run that project's documented command and type-check it before relying on a
   live result.

An agent can locate these projects and their supported commands through the
root [`catalog.json`](../catalog.json). See [`AGENTS.md`](../AGENTS.md) for the
repository-wide agent workflow.

## Contributing

New API recipes belong directly under `examples/<task-name>/`; do not add a
language-only nesting layer. Read the [contribution guide](../CONTRIBUTING.md)
for the required files, catalog metadata, and validation steps.
