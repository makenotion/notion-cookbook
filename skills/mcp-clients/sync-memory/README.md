# Sync Memory

Copy Codex's memory Markdown files into Notion Memories, one file per page. The
skill calls Notion through Codex's existing MCP connection and runs no model.
`SKILL.md` is the agent entrypoint; `scripts/` holds the copy commands.

The skill supports Codex memory only and installs no hooks or background service.
It declares `metadata.requires-client: codex`, so `npm run plugins:build` leaves it
out of the portable plugins under [`plugins/`](../../../plugins/). A Codex plugin
that bundles it ships `SKILL.md`, `agents/`, `scripts/`, `package.json` and
`tsconfig.json` as `skills/notion-sync-memory/`, leaves out `test/`, `evaluations/`
and `node_modules/`, and must declare `requires_local_executor: true` because the
scripts run on the user's computer.

## Behavior

`sync` reads every regular `*.md` file under `memories_v2/`, skipping `.git/`,
symbolic links and other extensions, and reports skipped paths as `unsupported`.
Each relative path, such as `rollout_summaries/session.md`, becomes a page title.
Pages use `Type: Notes`, `Source: Codex` and `Last updated by: Codex`, and start
with a metadata block before the original Markdown:

````markdown
# Codex memory source

```json
{
  "Source": "Codex",
  "Source root": "memories_v2",
  "Source path": "rollout_summaries/session.md",
  "Source created at": "2026-10-26T12:00:00.000Z",
  "Source updated at": "2026-10-26T13:00:00.000Z",
  "Synced at": "2026-10-26T13:00:05.000Z",
  "Synced by": "notion-memory"
}
```

---

Original file content starts here.
````

Text that Notion Markdown would read as a tag, such as `<page>`, is escaped outside
code so it stays literal. Notion may still normalize other Markdown, so this is not
a byte-preserving backup.

The mapping stores each path's page ID, source and timestamp hashes, and the page's
readback hash. Unchanged files make no Notion call. A changed file replaces the
same page's body. A page edited or deleted in Notion is released instead of
overwritten. Deleted or renamed source files leave their pages alone and appear as
`missing`. Content Notion rejects as invalid input appears as `rejected`; nothing is
written for it and other files continue.

## Setup

Requires Node.js 22.18+, Codex (tested with 0.165.0), Codex v2
memories, and a Notion workspace with Memories.

To install it by hand, copy this directory without `test/`, `evaluations/` and
`node_modules/` to `~/.codex/skills/notion-sync-memory/`, and connect Notion in Codex.

Settings live in `~/.codex/notion-memory.json`. `use-workspace --confirm <id>` writes
`expectedWorkspaceId`, which `sync`, `verify`, `status` and `reconcile` require.
`mcpServer` is required when Codex has more than one Notion connection. Each pinned
workspace keeps its own mapping under `~/.codex/notion-memory/<workspace-id>/`.
`sourceHome` and `NOTION_MEMORY_DATA` isolate the source and mapping for tests.

```json
{
  "mcpServer": "notion",
  "expectedWorkspaceId": "your-workspace-id"
}
```

Bulk copying of local memory and its consent, exclusion and forget behavior remain
release review items. Listing a Codex plugin that bundles it goes through OpenAI's
[desktop-only submission process](https://developers.openai.com/plugins/deploy/desktop-only).

## Commands

From the skill directory:

```sh
node scripts/main.ts preview
node scripts/main.ts sync
node scripts/main.ts verify
node scripts/main.ts status
node scripts/main.ts use-workspace [--confirm <workspace-id>]
node scripts/main.ts reconcile <source-path> --keep-notion <page-id>
node scripts/main.ts reconcile <source-path> --not-created
```

`preview` and `status` work offline. `verify` fetches every managed page and checks
its readback hash. Imports hold a cross-process lock that a killed process releases.

A write whose outcome is unknown, such as a lost create response, is journaled as
pending and blocks later syncs until it is reconciled; nothing is retried blindly.
`status` lists the pending paths and recovery commands, and `SKILL.md` describes
when each `reconcile` form is allowed.

## Files

| File                   | Role                                                     |
| ---------------------- | -------------------------------------------------------- |
| `scripts/main.ts`      | Command entrypoint and workspace pinning                 |
| `scripts/memories.ts`  | Inventory, sync, verify, reconcile and tag escaping      |
| `scripts/mcp.ts`       | Codex app-server client and Notion tool errors           |
| `scripts/config.ts`    | Settings, per-workspace mappings and logs                |
| `scripts/ownership.ts` | Cross-process lock                                       |
| `evaluations/`         | Agent scenarios per the [protocol](../../evaluations.md) |

## Validation

```sh
npm install
npm run check
npm test
CODEX_TEST_BINARY="$(command -v codex)" NOTION_TEST_SLOW=1 npm test
```

The `CODEX_TEST_BINARY` tests install the skill in an isolated Codex home, check
that Codex discovers it, and drive a Notion fixture through the real app-server
without a model. The
`sync-memory-test.yml` workflow runs them on Node.js 22.18.0 and 22.23.4 with Codex
0.165.0. OAuth in the desktop app and rendering in real Notion need separate live
checks.
