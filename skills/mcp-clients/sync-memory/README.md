# Sync Memory

Copy Codex's current memory Markdown files into Notion Memories, one file per
page. Relative file paths become page titles. Each page begins with source metadata,
then a separator and the original Markdown without plugin transformations.
The plugin calls Notion through Codex's existing MCP connection; it runs no model.

The canonical source lives beside the other Notion skills at
`skills/mcp-clients/sync-memory/`. `SKILL.md` is the agent entrypoint, and
`scripts/` holds its deterministic copy commands. Codex plugin metadata at `skills/.codex-plugin/plugin.json` and Claude Code plugin
metadata at `skills/.claude-plugin/plugin.json` point to this canonical directory
and its hooks for installation and automatic triggers. Claude Code copies each auto
memory file the same way. This page describes Codex first, and
[Claude Code](#claude-code) covers what differs there.

## Behavior

The plugin recursively reads every regular `*.md` file under `memories_v2/`,
including `rollout_summaries/` and `extensions/`. It skips `.git/`, symbolic links,
and files with other extensions. Paths use `/` separators and sort before import.

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
Missing files leave existing Notion pages alone. A missing required summary stops
the import; an explicitly empty file retains the metadata preamble with an empty
original-content section.

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

Install from the repository's bundled marketplace:

```sh
codex plugin marketplace add /absolute/path/to/notion-cookbook
codex plugin add sync-memory@notion-cookbook
```

In Codex, select `$sync-memory:sync-memory` or ask the agent to use Sync Memory to sync,
preview, verify, or inspect the mapping. Copy the whole directory when installing
the skill directly so its `scripts/` commands remain available. Automatic hooks
and the bundled Notion connection require the plugin installation.

The runtime test checks discovery of the skill through `skills/list`.

The bundled server uses Notion MCP. Complete Codex's normal OAuth login. If using
an already configured connection, set `mcpServer` in `~/.codex/notion-memory.json`.
For local imports, pin `expectedWorkspaceId` as well:

```json
{
  "codexPath": "codex",
  "nodePath": "/absolute/path/to/node",
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
older `notion-memory` development plugin before enabling Sync Memory's hooks.
Keep its configuration and state directory intact. There is no automatic removal
or migration of the old plugin installation.

Review and trust the two hooks in Codex (`/hooks` in the CLI). Until trusted,
hooks are skipped. New hook definitions require review again.

## Triggering

SessionStart and Stop hooks launch a detached worker and return quickly. Stop is
a Codex lifecycle event, not closing the application. The worker checks effective
`features.memories` once, syncs existing files, then polls every five seconds for
10 minutes after the initial SessionStart import or five minutes after Stop.
Later changes wait for the next hook or manual import. Polling waits for running
jobs in the v2 memory database to finish; database read errors stop the worker.
There is no continuously running service or native memory-updated event.

Manual `sync` explicitly imports retained files even if automatic memories are
currently disabled. Workers use a cross-process lock. Source content and metadata hashes skip unchanged
writes, and a readback hash protects external changes before an update.

## Commands

From the skill directory, using Node.js 22.18+:

```sh
node scripts/main.ts preview
node scripts/main.ts sync
node scripts/main.ts verify
node scripts/main.ts status
```

`preview` reads local files and their filesystem timestamps only. `verify` compares
current source content and metadata hashes with the
mapping and fetches every managed page to check its saved readback hash. Notion
may normalize Markdown formatting; this is not a byte-preserving backup format.
`sync` prints created/updated/unchanged and externally changed counts.

Known gaps against a full sync inventory are that unsupported formats and missing
previously synced files are silently skipped. A successful remote write followed
by failed readback can leave an unrecorded new page, or make a retry mistake the
plugin's own update for a human edit. The lock prevents overlapping imports but
does not resolve ambiguous write outcomes. `verify` checks saved readback hashes;
it does not prove that Notion retained every original source character.

## Processing points and files

| Processing point                                               | Implementation                                           |
| -------------------------------------------------------------- | -------------------------------------------------------- |
| Plugin registration and MCP endpoint                           | `../../.codex-plugin/plugin.json`, `.mcp.json`           |
| SessionStart / Stop registration                               | `hooks.json`                                             |
| Select Node runtime                                            | `hook.cjs`                                               |
| Manual command, detached worker, feature guard, watch window   | `scripts/main.ts`                                        |
| Recursively read current memory Markdown files unchanged       | `scripts/codex.ts` — `codexMemoryFiles`                  |
| One file / one page, attribution, update protection, readback  | `scripts/memories.ts` — `syncMemories`, `verifyMemories` |
| File polling and v2 job check                                  | `scripts/codex.ts` — `watchMemories`                     |
| Connection, OAuth-owned transport, workspace check, RPC errors | `scripts/mcp.ts`                                         |
| Settings, file mapping, atomic save, shared lock, logs         | `scripts/config.ts`                                      |
| On-demand agent instruction                                    | `SKILL.md`                                               |

Claude Code loads only a `.mcp.json` at its plugin root (`skills/`), so this
directory's `.mcp.json` stays Codex-only and adds no unauthenticated Notion server
to Claude Code sessions.

## Claude Code

Claude Code's [auto memory](https://code.claude.com/docs/en/memory) keeps one
Markdown file per memory in `~/.claude/projects/<project>/memory/`, with a
`name`, `description`, and `type` in its frontmatter. `MEMORY.md` in the same
directory is only an index, so the plugin skips it. Every other memory file
becomes one page with the same source metadata preamble as Codex, followed by its
Markdown, frontmatter included, unchanged. `Source root` is `projects` and
`Source path` is `<project>/memory/<file>`, or `autoMemoryDirectory` and `<file>`
when that setting is used. If you set `autoMemoryDirectory` in `~/.claude/settings.json`, the
plugin reads that directory instead.

| Source                                       | Notion page                               |
| -------------------------------------------- | ----------------------------------------- |
| `~/.claude/projects/<project>/memory/<file>` | `<project>/<file>`, such as `app/user.md` |
| `<autoMemoryDirectory>/<file>`               | `<file>`                                  |

The project is the working directory Claude Code derived the folder name from,
without your home directory. Pages take `Type` from the frontmatter `type`:
`user` → Profile, `feedback` → Preference, `project` → Work, anything else →
Notes. `Source` and `Last updated by` are `Claude Code`. Updates, edit protection,
and missing files work as for Codex: a deleted memory file leaves its page alone.
The plugin reads memories from every project, so run the preview first if some
projects hold memories you don't want in Notion.

Automatic syncs follow Claude Code's own auto memory switch, decided the way
Claude Code decides it: `CLAUDE_CODE_DISABLE_AUTO_MEMORY` (including from a
settings `env` block), then bare mode, then `autoMemoryEnabled` from managed,
the session project's local and shared, or user settings. When it is off, hooks
start no worker. A manual `sync` still copies the files that are there.

### Setup

```sh
claude plugin marketplace add /absolute/path/to/notion-cookbook
claude plugin install sync-memory@notion-cookbook
```

Inside Claude Code, `/plugin` does the same. Then sign in to Notion MCP once
and preview:

```sh
cd notion-cookbook/skills/mcp-clients/sync-memory
NOTION_MEMORY_AGENT=claude node scripts/main.ts login
NOTION_MEMORY_AGENT=claude node scripts/main.ts preview
```

Restart Claude Code to load the hooks.

### Signing in

Claude Code can't call its own MCP connections without a model turn, so the
plugin connects to `https://mcp.notion.com/mcp` itself. `login` registers an
OAuth client, opens Notion's consent page in your browser, and receives the
redirect on `127.0.0.1`. The tokens are stored in
`~/.claude/notion-memory/oauth.json`, readable only by you, and refreshed
automatically. Delete that file to sign out.

### Triggering in Claude Code

Claude Code writes memories with its own Write and Edit tools, so the plugin
doesn't need to watch for changes. A `PostToolUse` hook (`Write|Edit|MultiEdit`
on a memory file) copies a memory as soon as Claude saves it, and `SessionStart`
and `Stop` catch changes made any other way. Each starts a detached worker that
syncs once and exits. A hook starts no worker when there are no memories, auto
memory is off, or you have not signed in yet; the last two are logged. Every
request to Notion has a 60-second timeout. A worker holds the lock while it is
connected, so overlapping hooks never refresh the OAuth token at the same time.
State, tokens, and logs live in `~/.claude/notion-memory/`, separate from
Codex's.

| Processing point                               | Implementation                                          |
| ---------------------------------------------- | ------------------------------------------------------- |
| Plugin registration and hooks                  | `../../.claude-plugin/plugin.json`, `claude-hooks.json` |
| Local marketplace                              | `../../../.claude-plugin/marketplace.json`              |
| Memory files, auto memory switch, hook filter  | `scripts/claude.ts`                                     |
| Sign-in, token refresh, Streamable HTTP to MCP | `scripts/notionMcp.ts`                                  |

## Validation

```sh
npm install
npm run check
npm test
CODEX_TEST_BINARY="$(command -v codex)" NOTION_TEST_SLOW=1 npm test
CLAUDE_TEST_BINARY="$(command -v claude)" npm test
```

Tests exercise nested files, distinct paths with the same basename, unchanged
Markdown, same-page updates, empty and missing files, excluded links and Git state,
external edits/deletions, notices, locks, worker polling and failures. Source metadata
tests cover birth time, metadata-only updates, unchanged-page stability and existing
mapping backfill.
The optional runtime test installs the real artifact in an isolated Codex home
and drives a stdio Notion fixture through the real app-server without a model.
Desktop trust/OAuth clicks and natural-conversation hook dispatch require separate
live verification; manually starting a worker does not prove that entire chain.

Claude Code gets the same treatment against `test/support/fake-notion-http.mjs`,
a local stand-in for mcp.notion.com (OAuth refresh and Streamable HTTP MCP) over
the same Notion fixture. Those tests run the hook commands exactly as written in
`claude-hooks.json` from a copy of the plugin in a path with spaces. The optional
runtime test installs through the real `claude plugin` commands into an empty
`CLAUDE_CONFIG_DIR` and runs the cached SessionStart hook. A real `login` against
Notion needs browser consent and is not automated.
