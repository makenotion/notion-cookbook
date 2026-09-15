# Canonical App agent files

This directory is the source for App templates' generated `.agents/` files.
Edit here and run `npm run agents:sync`; `npm run agents:check` detects drift,
including stale skills. Commit canonical files and generated copies together.
Templates also receive `AGENTS.md`, `CLAUDE.md`, and `.claude/skills` symlinks.

All catalog recipes with an `app-` kind use `instructions/default/` and the
App skill list in `scripts/sync-agent-files.mjs`. Worker groups remain sourced
from `workers/agents/`. Add new App skills to the App list only after checking
the SDK exports, implementation, and runtime context for the intended capability.

## Supported guidance

Notion as Code resource declarations can also supply databases for syncs.
See the [Notion as Code skill](skills/notion-as-code/SKILL.md) for declarations,
typed data source handles, and deployment behavior.

| Skill                                          | SDK surface                                                     |
| ---------------------------------------------- | --------------------------------------------------------------- |
| [Workflow](skills/workflow/SKILL.md)           | Typed triggers and durable steps                                |
| [Connections](skills/connections/SKILL.md)     | Workflow provider clients, trigger connection keys, and retries |
| [Sync](skills/sync/SKILL.md)                   | Notion as Code data source syncs and pagination                 |
| [Custom blocks](skills/custom-blocks/SKILL.md) | Browser project declarations and host integration               |

These instructions require an Apps SDK release with the creation-only root
exports: `page`, `database`, `teamspace`, `customAgent`, `sync`, `workflow`, and
`customBlock`. Examples use `import * as Notion from "@notionhq/apps"`; utilities
and types keep their existing subpaths. They replace
Worker registration, auth interception, and database assumptions with Apps APIs.
Worker tools and webhooks are not registered by the Apps capability discovery
implementation. Provider declarations do not guarantee server availability.
Check installed declarations when the alpha SDK changes.

## Validation

Run the catalog validator, agent drift check, root Markdown and format checks,
and the affected template's check/build. The sync regression tests run with
`npm run agents:test`. Use [evaluation scenarios](evaluations.md) when changing
skill behavior; they require no live credentials.
