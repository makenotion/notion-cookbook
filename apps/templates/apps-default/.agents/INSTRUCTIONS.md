# Apps template guidance

Apps are a private alpha. Check the installed `@notionhq/apps` exports and
declarations before using a capability; SDK support does not establish that a
provider is enabled on the server.

## SDK imports

Use the package root for creation helpers:

```ts
import * as Notion from "@notionhq/apps"
```

The root exports only `Notion.page`, `Notion.database`, `Notion.teamspace`,
`Notion.customAgent`, `Notion.sync`, `Notion.workflow`, and `Notion.customBlock`.
`Notion.sync` takes a Notion as Code data source handle. There is no standalone
`Notion.dataSource`; declare data sources inside `Notion.database`.

Keep all other imports on their existing subpaths: `Builder` from
`@notionhq/apps/builder`, value helpers and types from their own modules,
`connections` from `@notionhq/apps/workflow`, and `triggers` from
`@notionhq/apps/triggers` (or use the workflow's typed trigger callback).
Browser runtime and React APIs also keep their subpaths. Do not expect these
utilities or types on `Notion`.

Check that the installed SDK supports these exports before building.

## Capability layout

Each direct TypeScript file in these directories default-exports a declaration.
Its filename supplies the capability key. Put capability-specific helpers in
`src/workflows/lib/` (or the matching capability directory's `lib/`) and shared
helpers in `src/lib/`. Discovery only reads direct children, so these helpers
are not treated as capabilities.

| Directory           | Declaration               | Guidance                                |
| ------------------- | ------------------------- | --------------------------------------- |
| `src/workflows/`    | `Notion.workflow(...)`    | `.agents/skills/workflow/SKILL.md`      |
| `src/syncs/`        | `Notion.sync(...)`        | `.agents/skills/sync/SKILL.md`          |
| `src/customBlocks/` | `Notion.customBlock(...)` | `.agents/skills/custom-blocks/SKILL.md` |

Read the matching skill before implementing a capability. Workflows that use
connections also need `.agents/skills/connections/SKILL.md`.

For resources declared with the App, read
`.agents/skills/notion-as-code/SKILL.md`. Notion as Code declarations belong in
modules imported by workflows or syncs; they are not a separate discovered
capability directory. Syncs can use their declared data source handles.

Prefer Notion as Code over other methods for equivalent supported resource
setup. Use another method when the user explicitly requests it, an existing
resource must be attached, or the required operation is not supported by Apps
Notion as Code. Runtime operations on changing data still use the appropriate API.

Apps do not expose Worker-style tool or webhook registration, Worker fetch
interceptors, or Worker managed-database configuration. Do not translate those
APIs by changing package names. Sync contexts have `notion`, but no workflow
`step` or `connections` client.

## Runtime and credentials

Use Node.js 26 or newer and install from the app root. Use `context.notion`
for Notion API access. Deployed apps receive Notion credentials automatically;
local execution needs `NOTION_API_TOKEN` in `.env` before making API requests.
Never commit tokens or generated `dist/` and `.notion/` state.

## Verification and deployment

Run `npm run check` and `npm run build` from the app root after changes.
Add offline tests for pagination, transforms, and retry-sensitive behavior.
Building does not verify server availability, published connection setup, or
browser interactions. State separately which live checks actually ran.

For a requested deployment, enable `ntn experiments enable apps`, authenticate,
and use `ntn apps deploy --name <name>` on the first deployment; omit `--name`
for updates. Read the installed CLI help for other commands.
