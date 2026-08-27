# Notion-as-Code project

This is a TypeScript project that describes Notion workspace structure —
teamspaces, pages, databases, and entries — as code. It is built locally and
applied with the Notion CLI (`ntn`). Notion-as-Code is in alpha; the API may
reject requests in some environments.

## Layout

- `src/main.ts` is the entry point. Split code across `src/` files with
  standard imports; `npm run build` bundles them.
- `src/lib/` (`notion.ts`, `types.d.ts`, `entry.ts`) is the vendored
  Notion-as-Code runtime and types — never edit it.
- `npm run build` writes `dist/intents.json`, which is exactly what
  `ntn notion-as-code apply` submits.

## Authoring rules

- `import { notion } from "./lib/notion"` (adjust the relative path from
  nested directories) is the API. Scripts are declarative toward Notion:
  calls like `notion.teamspace(...)` record intents; nothing touches Notion
  until `apply`.
- The build runs under Node (`@types/node` is configured), so scripts may
  read local files (e.g. CSV via `node:fs`), import JSON files
  (`resolveJsonModule` — see `src/data/sample-projects.json` and the loop in
  `src/main.ts`), read environment variables, and add npm dependencies to
  `package.json`; esbuild bundles everything. Relative paths resolve from the
  project root (npm runs scripts there). Only the recorded intents reach
  Notion.
- Every resource needs a stable, unique `resourceId`; re-applying the same
  state name updates the same records. Never change a `resourceId` after a
  successful apply.
- Use exactly one workspace anchor per script: one `notion.space({...})` or
  one shared teamspace-parent `resourceId`.
- Page `content` is Notion-flavored Markdown; the full spec is the
  `NOTION_AS_CODE_MARKDOWN_SPEC` constant at the bottom of
  `src/lib/types.d.ts`.

## Commands

- `npm install` — once, to install dependencies.
- `npm run typecheck` — while editing.
- `npm run build` — inspect `dist/intents.json` without applying.
- `ntn login` — once per workspace.
- `ntn notion-as-code apply .` — builds, then applies. Use `--name <state>`
  for independent deployments and `--json` for machine output.
- `ntn notion-as-code list` — list saved states; `ntn notion-as-code state
show <name>` / `ntn notion-as-code state rm <name>` inspect or delete one.

## State semantics

State is saved under the CLI config directory at
`notion-as-code/<env>/<workspace-id>/<name>.json`, mapping `resourceId`s to
real Notion IDs. Deleting state makes the next apply create fresh resources.

## Safety

Never print or commit tokens. Applies write to a real Notion workspace.
