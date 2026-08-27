# Notion-as-Code project

Use this template to describe a Notion workspace — teamspaces, pages,
databases, and entries — as TypeScript. The Notion CLI builds the project and
applies that desired state. Re-applying updates the same resources instead of
creating duplicates.

> **Alpha:** Notion-as-Code is experimental and not publicly available. The API
> may reject requests in some environments.

## When to use it

Use this project when you want a repeatable, reviewable definition of workspace
structure. It is useful for provisioning a new workspace, keeping a standard
set of pages and databases current, or generating entries from local data.

## Prerequisites

- Node.js 18 or later
- The Notion CLI (`ntn`)
- A successful `ntn login` for the workspace you will manage

## Set up and apply

From this directory, install dependencies and inspect the generated intents:

```sh
npm install
npm run build
```

Apply the project to the logged-in workspace:

```sh
ntn notion-as-code apply .
```

The build writes `dist/intents.json`. Applying creates or updates the described
resources and records their IDs in the CLI state directory. Re-run the same
command after editing the project to update those resources.

## Project structure

- `src/main.ts` defines the workspace resources.
- `src/content.ts` contains reusable page content.
- `src/data/sample-projects.json` supplies sample database entries.
- `src/lib/` contains the vendored Notion-as-Code runtime and types. Do not
  edit it.

## Customize the project

Edit `src/main.ts` and the files it imports. Every resource needs a stable,
unique `resourceId`; changing one after a successful apply creates a new
resource. Use one workspace anchor per script, either with `notion.space(...)`
or a shared teamspace parent resource ID.

See [AGENTS.md](./AGENTS.md) for the complete authoring rules, state semantics,
and Notion-flavored Markdown reference.

## Verify changes

Run the typecheck before applying a change:

```sh
npm run typecheck
npm run build
```

`ntn notion-as-code apply .` writes to a real Notion workspace. Run it only
when the target workspace and expected changes are safe.
