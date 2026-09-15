# Apps template guidance

Apps are a private alpha. Check the installed `@notionhq/apps` exports and
declarations before using a capability; SDK support does not establish that a
provider is enabled on the server.

## Capability layout

Each direct TypeScript file in these directories default-exports a declaration.
Its filename supplies the capability key. Put capability-specific helpers in
`src/workflows/lib/` (or the matching capability directory's `lib/`) and shared
helpers in `src/lib/`. Discovery only reads direct children, so these helpers
are not treated as capabilities.

| Directory           | Declaration                                                       | Guidance                                |
| ------------------- | ----------------------------------------------------------------- | --------------------------------------- |
| `src/workflows/`    | `createWorkflow` from `@notionhq/apps/workflow`                   | `.agents/skills/workflow/SKILL.md`      |
| `src/syncs/`        | `createSync` or `createDataSourceSync` from `@notionhq/apps/sync` | `.agents/skills/sync/SKILL.md`          |
| `src/customBlocks/` | `createCustomBlock` from `@notionhq/apps/custom-block`            | `.agents/skills/custom-blocks/SKILL.md` |

Read the matching skill before implementing a capability. Workflows that use
connections also need `.agents/skills/connections/SKILL.md`, which includes
calendar operations.

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
