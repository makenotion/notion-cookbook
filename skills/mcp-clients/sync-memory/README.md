# Sync Memory

Copy Codex's current memory Markdown files into Notion Memories, one file per
page. Relative file paths become page titles. Each page begins with source metadata,
then a separator and the original Markdown without plugin transformations.
The plugin calls Notion through Codex's existing MCP connection; it runs no model.

The canonical source lives beside the other Notion skills at
`skills/mcp-clients/sync-memory/`. `SKILL.md` is the agent entrypoint, and
`scripts/` holds its deterministic copy commands. `npm run build:plugin` packages
this skill into `build/sync-memory/` at the repository root. The generated plugin
contains this skill, the shared Notion setup skill, runtime scripts, and Notion connection. Other
skills, tests, evaluations, and dependencies are excluded. Build output stays
untracked. The current runtime supports Codex memory only and declares desktop-only execution.
Installation registers no lifecycle hooks or background service.

## Behavior

The plugin recursively reads every regular `*.md` file under `memories_v2/`,
including `rollout_summaries/` and `extensions/`. It skips `.git/`, symbolic links,
and files with other extensions. Unsupported files and skipped symbolic links
appear in the command result.
Paths use `/` separators and sort before import.

| Source                                              | Notion page                             |
| --------------------------------------------------- | --------------------------------------- |
| `memories_v2/memory_summary.md`                     | `memory_summary.md`                     |
| `memories_v2/rollout_summaries/session.md`          | `rollout_summaries/session.md`          |
| `memories_v2/extensions/ad_hoc/notes/preference.md` | `extensions/ad_hoc/notes/preference.md` |

`MEMORY.md` is copied if present, but Codex v2 normally does not generate it.

Pages use `Type: Notes`, `Source: Codex`, and `Last updated by: Codex`. Changed files
replace the same page's body. Updates preserve the original Source. Unchanged
files require no Notion call. The local state maps relative paths to page IDs and
source/readback hashes plus a hash of source creation and modification times.
A source timestamp change updates the same page even if its text is unchanged.

If a managed page was edited or deleted in Notion, the next attempted update
releases it instead of overwriting or recreating it. Source files stay untouched.
Missing files leave existing Notion pages alone and appear in the command result.
A missing summary does not block other Markdown files. An explicitly empty file
retains the metadata preamble with an empty original-content section.

This version only reads v2. It performs no chapter parsing, rewriting, deduplication,
classification, raw extraction import, source archival, version selection, legacy
migration, or automatic deletion. Existing unrelated or older pages stay untouched;
new file pages are created without adopting existing same-title pages.

## Source metadata

The database keeps its existing fields. No source metadata properties are added.
Each page starts with `# Codex memory source`, a JSON code block, and a separator:

````markdown
# Codex memory source

```json
{
  "Source": "Codex",
  "Source root": "memories_v2",
  "Source path": "extensions/ad_hoc/notes/preference.md",
  "Source created at": "2026-10-26T12:00:00.000Z",
  "Source updated at": "2026-10-26T13:00:00.000Z",
  "Synced at": "2026-10-26T13:00:05.000Z",
  "Synced by": "notion-memory"
}
```

---

Original file content starts here.
````

Creation time uses a valid positive filesystem birth time, otherwise JSON `null`.
It never substitutes ctime. Modification time uses filesystem mtime. Source root
and path exclude the absolute home directory. `Synced at` is sampled just before
the successful write attempt, not at API completion; unchanged files keep their
previous value. It is excluded from change detection.

The source suffix is passed unchanged, including empty content and whitespace.
Notion may normalize its imported representation. `Source` identifies Codex memory,
not the original author of every sentence. `Synced by` identifies this copying
plugin. Native client attribution remains Codex, while Notion system timestamps
and caller identities stay managed by Notion.

Existing file mappings without a metadata hash update the same page once to add
the preamble, subject to the existing protection for human edits.

## Requirements and setup

- Node.js 22.18+ and Codex with plugin support (tested with 0.164.0-alpha.11.1).
- Codex memories enabled and v2 memory artifacts already generated. The plugin
  does not migrate or regenerate Codex memory. Codex can dual-write v1/v2 and keeps
  their state separate; v2 does not guarantee importing old manually written notes.
- A Notion workspace with Memories enabled and a connected Notion MCP server.

Build the plugin with Node.js 22.18+ from the repository checkout, then install
from its bundled marketplace:

```sh
cd /absolute/path/to/notion-cookbook/skills/mcp-clients/sync-memory
npm run build:plugin
codex plugin marketplace add /absolute/path/to/notion-cookbook
codex plugin add sync-memory@notion-cookbook
```

The build command prints the generated plugin directory. Build again before
installing an updated checkout. The marketplace points to `build/sync-memory/`,
not to the whole skills collection.

In Codex, select `$sync-memory:sync-memory` or ask the agent to use Sync Memory to sync,
preview, verify, or inspect the mapping. Copy the whole directory when installing
the skill directly so its `scripts/` commands remain available.
The bundled Notion connection requires the plugin installation.

The runtime test checks discovery of the skill through `skills/list`.

The bundled server uses Notion MCP. Complete Codex's normal OAuth login. If using
an already configured connection, set `mcpServer` in `~/.codex/notion-memory.json`.
Before any import, confirm the approved workspace with Notion get-self and pin
`expectedWorkspaceId`. Both `sync` and `reconcile` require the pin, including manual
invocations, and validate it before accessing memory pages. When more than one Notion connection
is available, `mcpServer` is also required; there is no first-server fallback:

```json
{
  "codexPath": "codex",
  "mcpServer": "notion-local",
  "expectedWorkspaceId": "your-local-workspace-id"
}
```

Optional `sourceHome` selects a different Codex home for tests. Credentials remain
with Codex. The plugin never reads OAuth tokens. `NOTION_MEMORY_DATA` isolates a
mapping directory when testing. The old topic/archive mapping is unsupported;
start with a fresh mapping directory when replacing a development installation.
Old Notion pages and old memory files are not migrated or removed.

The product and skill are named Sync Memory. The existing `notion-memory`
configuration, mapping and log paths, `NOTION_MEMORY_*` environment variables, and
`Synced by: notion-memory` metadata remain stable. Renaming does not create a new
mapping namespace or require rewriting existing pages. Disable or uninstall an
older development plugin with automatic hooks before using this release.
Keep its configuration and state directory intact. There is no automatic removal
or migration of an old plugin installation.

## Execution and authorization

Each explicit `sync` invocation imports the current source inventory, then exits.
There is no watcher, session hook, login item, or automatic restart in this package.
A changed import starts one Codex app-server subprocess through the existing Codex
authentication. An unchanged import starts none. Imports use a cross-process lock.
Source content and metadata hashes skip unchanged writes, and a readback hash
protects external changes before an update. The command does not read Codex's
private SQLite database or regenerate memory when automatic memories are disabled.

Before the first import, confirm the source inventory, target workspace, destination
visibility, and authorization to copy the existing files. Reuse explicit approval
for the same scope. A one-time import approval does not authorize recurring jobs.
The command copies the whole inventory and does not enforce content exclusions;
if approval excludes any source file, stop rather than claim a filtered import.

The shared [Notion setup skill](../setup/SKILL.md) is bundled unchanged and registered
as this plugin's onboarding flow. It delegates supported local memory imports and
approved recurring imports to Sync Memory, using the host's native scheduler. This package reuses the Notion
plugin's [privacy](https://privacycenter.notion.so/policies) and
[terms](https://notion.notion.site/Terms-and-Privacy-28ffdd083dc3473e9c2da6ec011b58ac)
listing URLs. Those links do not establish legal coverage for bulk local-memory
copying. Persistent consent enforcement, exclusions and forget behavior,
background execution, and public submission remain release review items.

During setup, the agent can create an explicitly approved local Scheduled task
that invokes the same one-shot command with a fixed config and mapping. The
computer and desktop app must remain running. The plugin implements no scheduler
and creates no task merely from installation. Public directory eligibility must still be
confirmed through OpenAI's [desktop-only submission process](https://developers.openai.com/plugins/deploy/desktop-only).

## Commands

From the skill directory, using Node.js 22.18+:

```sh
node scripts/main.ts preview
node scripts/main.ts sync
node scripts/main.ts verify
node scripts/main.ts status
node scripts/main.ts reconcile "rollout_summaries/session.md" --keep-notion <page-id>
```

`preview` reads local files and their filesystem timestamps only. Its result has
`files` and `unsupported` arrays. `verify` compares
current source content and metadata hashes with the
mapping and fetches every managed page to check its saved readback hash. Notion
may normalize Markdown formatting; this is not a byte-preserving backup format.
`sync` prints created, updated, unchanged, and externally changed counts. Both
`sync` and `verify` report unsupported files and previously mapped paths that no
longer exist. They never delete source files or Notion pages.

After a confirmed write, the mapping records the page ID and a pending readback
before fetching the page. If that fetch fails, the next run retries the readback
without creating another page or treating the plugin's own update as an external
edit. Recovery requires the page to match the submitted fingerprint; if it differs,
including because Notion normalized Markdown, synchronization stops for reconciliation
instead of adopting possible human edits. A successful immediate readback accepts
Notion's normalized representation. If the write itself has an unknown outcome,
synchronization stops and directs the user to `status`. It does not blindly retry the write. `verify` rejects unresolved
writes and checks saved readback hashes. It does not prove that Notion retained every original source
character.

### Recover a pending write

An unresolved write stops the whole import so a partial batch cannot look like a
complete sync. The native scheduled task receives a failing command; its saved
notification settings control how the user is notified. No hook or silent worker
is involved.

1. Run `status` with the same config and mapping. It shows each pending source path,
   operation, phase, known page ID, and recovery command arguments without connecting.
2. Inspect the affected page in the pinned workspace. If a create response was
   lost, find the page by its title and Source path. A timeout does not prove the
   write failed. If the page cannot be identified or fetched, preserve the pending
   entry and report the unresolved outcome.
3. With explicit user approval to keep the Notion page and stop managing that
   source path, run `reconcile <source-path> --keep-notion <page-id>`.

`reconcile` fetches the page, marks the path released, and clears only its pending
entry under the same lock. A known pending page ID must match. A workspace mismatch
or failed read leaves the state intact. It never creates, edits, or deletes a Notion
page, retries an unknown write, or adopts human content as a writable baseline.
Other files can sync afterward. The released file remains unsynced and `verify`
continues to report it; recovery does not mean the file was successfully copied.
There is no reset-and-retry command for an unlocated page.

## Processing points and files

| Processing point                                               | Implementation                                                              |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Plugin registration and MCP endpoint                           | `.codex-plugin/plugin.json`, `.mcp.json`                                    |
| Manual command and lazy connection lifetime                    | `scripts/main.ts`                                                           |
| Recursively read current memory Markdown files unchanged       | `scripts/memories.ts` — `memoryInventory`                                   |
| One file / one page, attribution, update protection, readback  | `scripts/memories.ts` — `syncMemories`, `verifyMemories`, `reconcileMemory` |
| Connection, OAuth-owned transport, workspace check, RPC errors | `scripts/mcp.ts`                                                            |
| Settings, file mapping, atomic save, logs                      | `scripts/config.ts`                                                         |
| Cross-process ownership for imports                            | `scripts/ownership.ts`                                                      |
| On-demand agent instruction                                    | `SKILL.md`                                                                  |
| Generate the isolated plugin artifact                          | `scripts/build-plugin.mjs`                                                  |

## Validation

```sh
npm install
npm run check
npm test
CODEX_TEST_BINARY="$(command -v codex)" NOTION_TEST_SLOW=1 npm test
```

Tests exercise nested files, distinct paths with the same basename, unchanged
Markdown, same-page updates, empty and missing files, excluded links and Git state,
external edits/deletions, notices, locks, removed automatic entrypoints and failures. Source metadata
tests cover birth time, metadata-only updates, unchanged-page stability and existing
mapping backfill.
The dedicated `sync-memory-test.yml` workflow runs the checks on Node.js 22.18.0
and 22.23.4 with Codex 0.165.0. Skills are excluded from the general cookbook
recipe runner. Skill evaluation scenarios use the separate
[evaluation instructions](evaluations/README.md), not `npm test`.

The optional runtime test builds and installs the real artifact in an isolated Codex home
and drives a stdio Notion fixture through the real app-server without a model.
Desktop installation/OAuth clicks and real Notion import rendering require separate
live verification. Installation and skill discovery alone must not write memory.
