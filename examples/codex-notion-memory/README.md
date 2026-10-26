# Codex Notion Memory

Copy Codex's current memory Markdown files into Notion Memories, one file per
page. File names become page titles and Markdown is passed through unchanged.
The plugin calls Notion through Codex's existing MCP connection; it runs no model.

The same plugin directory also installs into Claude Code, where it copies each
auto memory file the same way. This page describes Codex first, and
[Claude Code](#claude-code) covers what differs there.

## Behavior

| Source                              | Notion page         |
| ----------------------------------- | ------------------- |
| `memories_v2/memory_summary.md`     | `memory_summary.md` |
| `memories_v2/MEMORY.md`, if present | `MEMORY.md`         |

Pages use `Type: Notes`, `Source: Codex`, and `Last updated by: Codex`. Changed files
replace the same page's body. Updates preserve the original Source. Unchanged
files require no Notion call. The local state maps file names to page IDs and
source/readback hashes.

If a managed page was edited or deleted in Notion, the next attempted update
releases it instead of overwriting or recreating it. Source files stay untouched.
Missing files leave existing Notion pages alone. A missing required summary stops
the import; an explicitly empty file copies empty content.

This version only reads v2. It performs no chapter parsing, rewriting, deduplication,
classification, raw extraction import, source archival, version selection, legacy
migration, or automatic deletion. Existing unrelated or older pages stay untouched;
new file pages are created without adopting existing same-title pages.

## Requirements and setup

- Node.js 22.18+ and Codex with plugin support (tested with 0.164.0-alpha.11.1).
- Codex memories enabled and v2 memory artifacts already generated. The plugin
  does not migrate or regenerate Codex memory. Codex can dual-write v1/v2 and keeps
  their state separate; v2 does not guarantee importing old manually written notes.
- A Notion workspace with Memories enabled and a connected Notion MCP server.

Install from this directory's bundled marketplace:

```sh
codex plugin marketplace add /absolute/path/to/notion-cookbook/examples/codex-notion-memory
codex plugin add notion-memory@notion-cookbook
```

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
currently disabled. Workers use a cross-process lock. A source hash skips unchanged
writes, and a readback hash protects external changes before an update.

## Commands

From an installed plugin root, using Node.js 22.18+:

```sh
node src/main.ts preview
node src/main.ts sync
node src/main.ts verify
node src/main.ts status
```

`preview` reads local files only. `verify` compares current source hashes with the
mapping and fetches every managed page to check its saved readback hash. Notion
may normalize Markdown formatting; this is not a byte-preserving backup format.
`sync` prints created/updated/unchanged and externally changed counts.

## Processing points and files

| Processing point                                               | Implementation                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------- |
| Plugin registration and MCP endpoint                           | `plugin/.codex-plugin/plugin.json`, `plugin/codex-mcp.json` |
| SessionStart / Stop registration                               | `plugin/hooks.json`                                         |
| Select Node runtime                                            | `plugin/hook.cjs`                                           |
| Manual command, detached worker, feature guard, watch window   | `plugin/src/main.ts`                                        |
| Read the two current Markdown files unchanged                  | `plugin/src/codex.ts` — `codexMemoryFiles`                  |
| One file / one page, attribution, update protection, readback  | `plugin/src/memories.ts` — `syncMemories`, `verifyMemories` |
| File polling and v2 job check                                  | `plugin/src/codex.ts` — `watchMemories`                     |
| Connection, OAuth-owned transport, workspace check, RPC errors | `plugin/src/mcp.ts`                                         |
| Settings, file mapping, atomic save, shared lock, logs         | `plugin/src/config.ts`                                      |
| On-demand agent instruction                                    | `plugin/skills/notion-memory/SKILL.md`                      |

The Codex MCP server is in `codex-mcp.json` rather than `.mcp.json` because
Claude Code loads a plugin's `.mcp.json` automatically, which would add a
second, unauthenticated Notion server to every Claude Code session.

## Claude Code

Claude Code's [auto memory](https://code.claude.com/docs/en/memory) keeps one
Markdown file per memory in `~/.claude/projects/<project>/memory/`, with a
`name`, `description`, and `type` in its frontmatter. `MEMORY.md` in the same
directory is only an index, so the plugin skips it. Every other memory file
becomes one page, with its Markdown, frontmatter included, passed through
unchanged. If you set `autoMemoryDirectory` in `~/.claude/settings.json`, the
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
claude plugin marketplace add ./notion-cookbook/examples/codex-notion-memory
claude plugin install notion-memory@notion-cookbook
```

Inside Claude Code, `/plugin` does the same. Then sign in to Notion MCP once
and preview:

```sh
cd notion-cookbook/examples/codex-notion-memory
NOTION_MEMORY_AGENT=claude node plugin/src/main.ts login
NOTION_MEMORY_AGENT=claude node plugin/src/main.ts preview
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

| Processing point                               | Implementation                                                  |
| ---------------------------------------------- | --------------------------------------------------------------- |
| Plugin registration and hooks                  | `plugin/.claude-plugin/plugin.json`, `plugin/claude-hooks.json` |
| Local marketplace                              | `.claude-plugin/marketplace.json`                               |
| Memory files, auto memory switch, hook filter  | `plugin/src/claude.ts`                                          |
| Sign-in, token refresh, Streamable HTTP to MCP | `plugin/src/notionMcp.ts`                                       |

## Validation

```sh
npm install
npm run check
npm test
CODEX_TEST_BINARY="$(command -v codex)" NOTION_TEST_SLOW=1 npm test
CLAUDE_TEST_BINARY="$(command -v claude)" npm test
```

Tests exercise unchanged Markdown, one file per page, same-page updates, empty and
missing files, external edits/deletions, notices, locks, worker polling and failures.
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
