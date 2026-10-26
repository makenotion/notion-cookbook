# Codex Notion Memory

A [Codex](https://developers.openai.com/codex) and
[Claude Code](https://code.claude.com) plugin that mirrors the memories your
coding agent builds about you into your Notion Memories, so Notion Agent knows
the same preferences and project context that the agent learned. The same
plugin directory installs into both; this page describes Codex first, and
[Claude Code](#claude-code) covers what differs there.

This standalone plugin is distributed from Notion Cookbook through the bundled
marketplace. Its source, releases, and installation instructions live here.

It writes through [Notion MCP](https://developers.notion.com/docs/mcp), the
same tools and the same `parent: "memory"` write that the
[Notion memory setup prompt](https://developers.notion.com/prompts/setup) asks
an agent to use. The difference is who decides to write: with the prompt, the
model has to remember to save memories, and it cannot see what the agent saves
on its own. The plugin reacts to the agent's own memory updates and writes the
same result every time.

## What it does

Codex extracts and consolidates memories in the background. The plugin projects
its consolidated `memory_summary.md` and, when present, `MEMORY.md` into current
Notion topics. It prefers `memories_v2/` only when its summary exists. It does
not infer new facts or call a model.

| Consolidated source             | Active Notion memory                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| User Profile                    | Role and background (Profile)                                                                         |
| User preferences                | Coding workflow preferences (Preference)                                                              |
| General Tips                    | Working practices (Preference)                                                                        |
| What's in Memory topic headings | One Work page per consolidated topic                                                                  |
| MEMORY.md groups                | Durable preferences, reusable knowledge and lessons; task history and retrieval metadata are excluded |

Raw extraction records, rollout summaries and source files are supporting evidence,
not active memories. With the optional archive enabled, they live under a separate
private **Codex memory source archive** page. Current knowledge links to that archive.
This is a projection of consolidated knowledge, not a claim to re-extract every
fact from historical evidence.

New knowledge pages set `Source` and `Last updated by` to `Codex`. Updates keep
an existing `Source` and set `Last updated by` to `Codex`. The next sync backfills
missing attribution on older, unedited managed knowledge pages without rewriting
their content. Unmanaged pages and source archives are left alone. This identifies
the originating client and the syncing client; it does not imply that a model
directly authored the Notion write or identify a particular model.

| Source change                                         | Sync behavior                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| Append or override a topic                            | Update the same managed page; no semantic merge or duplicate append             |
| New topic                                             | Create one page with a stable key derived from its topic heading                |
| Removed topic, including an explicitly empty source   | Move the unedited managed page out of Memories and clear its old knowledge text |
| Entire source file unexpectedly missing or unreadable | Fail rather than interpreting a transient read failure as a mass deletion       |
| Notion page edited or deleted externally              | Release it from sync; never overwrite or resurrect the user's version           |
| Identically titled page not owned by this plugin      | Leave it alone                                                                  |

Retraction is not a permanent erase of Notion history: it clears the plugin-owned
projection after moving it out of active Memories. The source archive can still
contain historical supporting evidence; this is not a cross-system privacy erasure
operation. The plugin never automatically confirms Trash requests or edits About.
Failed moves stop the sync and preserve a retryable state; they are not bypassed.

## Prerequisites

- Codex CLI or the Codex app with plugin support (tested with
  `codex-cli 0.164.0`). The worker runs `codex app-server`, so the `codex`
  command must be on the `PATH` that Codex hooks use. Otherwise set
  `codexPath` in `~/.codex/notion-memory.json` or `CODEX_PATH`.
- Codex memories turned on in `~/.codex/config.toml`:

  ```toml
  [features]
  memories = true
  ```

- Node.js 22.18 or newer. The plugin runs its TypeScript sources directly with
  Node's built-in type stripping, so there is no build step and no runtime
  dependency.
- A Notion workspace where Notion Memories are available to MCP clients.

## Setup

### 1. Install the plugin

Add this directory as a local Codex marketplace and install the plugin:

```sh
git clone https://github.com/makenotion/notion-cookbook.git
codex plugin marketplace add ./notion-cookbook/examples/codex-notion-memory
codex plugin add notion-memory@notion-cookbook
```

You can also open `/plugins` in Codex and install **Notion Memory** from the
**Notion Cookbook** marketplace.

### 2. Connect Notion

The plugin bundles the same Notion MCP server as the official Codex Notion
plugin (`https://mcp.notion.com/mcp`). Codex runs the OAuth flow and keeps the
credentials. The plugin never sees a Notion token. Sign in when Codex asks
during install, or run:

```sh
codex mcp login notion
```

If you already have a Notion MCP server configured in Codex, the plugin uses
that connection instead. It can also resolve tools from an already-connected
Notion app on `codex_apps`; this package does not register a hosted app.
The hosted app route has offline tool-resolution coverage but has not been
verified with a live connection.

### Optional source archive and 0.2 migration

For an explicitly authorized full source backup, set `sourceArchive: true`.
This is **additive**: it keeps current knowledge in Memories and complete retained
sources outside Memories. The inventory includes non-hidden Markdown in
`memories/` and `memories_v2/` plus SQLite `stage1_outputs` extraction rows.
Git internals, symlinks, temporary files, job state and transcripts are excluded.
Unreadable sources fail the run.

Archive parts are 4,000 Unicode code points. Each part has a source path, part
number and its own SHA-256. An append updates only the previous tail and new parts;
unchanged prefix parts stay unchanged. Removed parts have their obsolete text
cleared. `inventory` reports full-source hashes; `verify` reads and compares every
expected part. Archive metadata is Unicode-escaped to survive Markdown conversion.

Version 0.3 migrates plugin-owned 0.2 `archive:*` pages using their stored page IDs
and ownership hashes. It moves them to the private archive before writing the new
projections. It leaves externally edited/deleted pages alone. Interrupted moves
are journaled so retry can recognize an already-moved page. Back up the state file
before a migration. If the normal move-pages tool refuses the operation, stop and
report the failure; do not copy credentials, forge deletion confirmation, or
manually rewrite Notion storage.

Pin the destination for local-only imports:

```json
{
  "mcpServer": "notion-local",
  "expectedWorkspaceId": "your-local-workspace-id",
  "sourceArchive": true
}
```

Register it with `codex mcp add notion-local --url <local-MCP-URL>` and complete
Codex's normal OAuth flow. An explicit server never falls back. `get-self` checks
the workspace before writes. Credentials remain with Codex. `NOTION_MEMORY_DATA`
isolates test mapping state without copying credentials or changing real sources.

### 3. Trust the hooks

The plugin works through two Codex hooks, `SessionStart` and `Stop`. The next
time you start Codex it asks you to review them. Trust them to enable imports.
New or changed hook definitions must be reviewed again. Until trusted, hooks
are skipped. In the CLI, open `/hooks` to review and trust them.

### 4. Preview, then use Codex

See what the plugin would write, without calling Notion:

```sh
npm run preview
```

Then keep using Codex. Codex only consolidates memories from sessions that have
been idle for a while, so the first import can take hours. Ask Codex "sync my
memories to Notion" to use the bundled `notion-memory` skill for a manual
import.

## How it works

Codex has no hook for "memories updated", so the plugin watches for it:

```text
SessionStart or Stop hook
  └─ node plugin/src/main.ts hook <event>          (returns immediately)
       └─ detached worker: node plugin/src/main.ts worker <event>
            ├─ when a write is needed: codex app-server → ephemeral thread → Notion tools
            ├─ import memories once (no-op when nothing changed)
            └─ every 5 s, for 10 min after the initial import / 5 min after Stop:
                 ├─ is a memory job running in either generation’s SQLite database? (read-only)
                 ├─ did a selected source change (all archive sources in archive mode)?
                 └─ changed and no job running → import
```

The worker calls Notion MCP tools through Codex's `mcpServer/tool/call`
app-server method, on an ephemeral thread. No model runs, and ephemeral threads
are not fed back into Codex memories. The Notion connection is lazy: an empty
or unchanged import does not connect after the user name is cached.
The hook starts no worker when neither the selected memory directory nor the
legacy memory database exists. The watcher uses the full window even if no job
is running. A change during the initial import is checked again afterward.
Before an automatic import, the worker reads effective Codex configuration using
`config/read`, without creating a thread. When memories are disabled, it logs a
skip and exits even if old files remain. Manual `sync` is an explicit import and
can still read retained files. An active watcher checks the setting at startup;
disable the plugin or stop its workers to stop an already-running watch window.
An import uses these tools (hosted app names are resolved separately):

| Tool                        | Used for                                              |
| --------------------------- | ----------------------------------------------------- |
| `notion-get-self`           | Your first name, used instead of "the user" (cached). |
| `notion-fetch` `memory`     | The Memories data source.                             |
| `notion-query-data-sources` | Titles of existing memories, to avoid duplicates.     |
| `notion-create-pages`       | New memories, with `parent: "memory"`.                |
| `notion-fetch` page         | Reading a page back before updating it.               |
| `notion-update-page`        | `replace_content` for memories Codex rewrote.         |
| `notion-finish-revision`    | Naming the revision that holds the updates.           |

Automatic imports are bounded, not an always-on service. Changes after a worker
exits wait for the next trusted hook (or explicit sync). A consolidation starting
late or running beyond the window can therefore be delayed; there is no
"memories updated" hook. Runtime hook dispatch and a normal new consolidation
need separate live verification: an ephemeral `thread/start` without a model
turn does not prove either.

Hooks block Codex while they run, so the hook only spawns a detached worker and
exits. The worker's own `codex app-server` runs with `NOTION_MEMORY_WORKER=1`,
and the hook does nothing when it sees that variable, so it never recurses.

The worker logs to `~/.codex/notion-memory/notion-memory.log`. A lock directory
there serializes workers, so overlapping hooks never create the same memory
twice. The mapping from Codex memory to Notion page is stored in
`~/.codex/notion-memory/state.json`. Errors are logged and never fail the hook.

> [!NOTE]
> `codex app-server` is marked experimental, and `mcpServer/tool/call` may
> change between Codex releases.

## Claude Code

Claude Code's [auto memory](https://code.claude.com/docs/en/memory) keeps one
Markdown file per memory in `~/.claude/projects/<project>/memory/`, with a
`name`, `description`, and `type` in its frontmatter. `MEMORY.md` in the same
directory is only an index, so the plugin skips it. Each file is already one
topic, so each becomes one Notion memory: the title comes from `name`, and the
body starts with the `description`.

| Claude Code memory `type` | Notion memory                         |
| ------------------------- | ------------------------------------- |
| `user`                    | **Profile**                           |
| `feedback`                | **Preference**                        |
| `project`                 | **Work**, noting the project it is in |
| `reference`               | **Notes**                             |

Writing, duplicate checks, edit protection, and retraction are the same as for
Codex: when Claude Code deletes a memory file, the unedited managed page moves
out of Memories under a private **Claude Code memory source archive** page and
its text is cleared. Attribution uses `Claude Code` for `Source` and `Last
updated by`. There is no source archive mode for Claude Code. The
plugin reads memories from every project, so run the preview first if some
projects hold memories you don't want in Notion. If you set
`autoMemoryDirectory` in `~/.claude/settings.json`, it reads that directory
instead.

Automatic syncs follow Claude Code's own auto memory switch, decided the way
Claude Code decides it: `CLAUDE_CODE_DISABLE_AUTO_MEMORY` (including from a
settings `env` block), then bare mode, then `autoMemoryEnabled` from managed,
the session project's local and shared, or user settings. When it is off, hooks
start no worker. A manual `sync` still imports the files that are there.

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
NOTION_MEMORY_AGENT=claude npm run preview
```

Restart Claude Code to load the hooks.

### Signing in

Claude Code can't call its own MCP connections without a model turn, so the
plugin connects to `https://mcp.notion.com/mcp` itself. `login` registers an
OAuth client, opens Notion's consent page in your browser, and receives the
redirect on `127.0.0.1`. The tokens are stored in
`~/.claude/notion-memory/oauth.json`, readable only by you, and refreshed
automatically. Delete that file to sign out.

### How it works

Claude Code writes memories with its own Write and Edit tools, so the plugin
doesn't need to watch for changes:

```text
PostToolUse hook (Write|Edit on ~/.claude/projects/*/memory/*.md)
SessionStart or Stop hook
  └─ NOTION_MEMORY_AGENT=claude node plugin/hook.cjs <event>   (returns immediately)
       └─ detached worker: Notion MCP over HTTP → import memories once
```

`PostToolUse` imports a memory as soon as Claude saves it. `SessionStart` and
`Stop` catch changes made any other way, such as a memory deleted with `rm`. A
hook starts no worker when there are no memories, auto memory is off, or you
have not signed in yet; the last two are logged. Every request to Notion has a
60-second timeout, and a worker connects only when a memory changed. A
worker holds the lock while it is connected, so overlapping hooks never refresh
the OAuth token at the same time. State, tokens, and logs live in
`~/.claude/notion-memory/`, separate from Codex's.

Set `NOTION_MEMORY_AGENT=claude` for every manual command, and use `mcpUrl` or
`NOTION_MCP_URL` in `~/.claude/notion-memory.json` to point at another Notion
MCP endpoint. `nodePath` works there too, for hooks that inherit an older Node.

## Code map

| Path                                | Purpose                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `.agents/plugins/marketplace.json`  | Local Codex marketplace that lists the plugin.                          |
| `.claude-plugin/marketplace.json`   | Local Claude Code marketplace that lists the plugin.                    |
| `plugin/.codex-plugin/plugin.json`  | Codex manifest: hooks, MCP server, skill, and display metadata.         |
| `plugin/.claude-plugin/plugin.json` | Claude Code manifest.                                                   |
| `plugin/codex-mcp.json`             | Notion MCP server, identical to the official Codex Notion plugin.       |
| `plugin/hooks.json`                 | Codex `SessionStart` and `Stop` hooks.                                  |
| `plugin/claude-hooks.json`          | Claude Code `SessionStart`, `PostToolUse`, and `Stop` hooks.            |
| `plugin/hook.cjs`                   | Selects the configured Node runtime before loading TypeScript.          |
| `plugin/skills/notion-memory/`      | Skill both agents use for manual imports and status.                    |
| `plugin/src/main.ts`                | Entrypoint: hook handling, detached workers, and manual commands.       |
| `plugin/src/memories.ts`            | Shared sync entry: each agent's memory source, then reconcile.          |
| `plugin/src/reconcile.ts`           | Creates, updates, retracts and migrates managed projections.            |
| `plugin/src/codex.ts`               | Codex source selection and the watcher for completed updates.           |
| `plugin/src/knowledge.ts`           | Projects consolidated Codex topics without extraction logs.             |
| `plugin/src/archive.ts`             | Complete retained-source inventory, encoding and readback verification. |
| `plugin/src/claude.ts`              | Maps Claude Code auto memory files to memories.                         |
| `plugin/src/mcp.ts`                 | Calls Notion MCP tools through `codex app-server`.                      |
| `plugin/src/notionMcp.ts`           | Calls Notion MCP over HTTP with its own OAuth, for Claude Code.         |
| `plugin/src/config.ts`              | Configuration, state, logging, and the cross-process lock.              |

The Codex MCP server is in `codex-mcp.json` rather than `.mcp.json` because
Claude Code loads a plugin's `.mcp.json` automatically, which would add a
second, unauthenticated Notion server to every Claude Code session.

The installed `plugin/package.json` declares ESM and the Node requirement.
Both agents copy the plugin directory into their cache without running
`npm install`, so the plugin has no runtime dependencies.

## Configuration

Optional. `~/.codex/notion-memory.json` (or `$NOTION_MEMORY_CONFIG`):

| Key                   | Environment variable | Meaning                                                                        |
| --------------------- | -------------------- | ------------------------------------------------------------------------------ |
| `nodePath`            | —                    | Node executable for hooks when their inherited PATH has an older Node.         |
| `sourceHome`          | —                    | Read memory sources from this Codex home; defaults to `CODEX_HOME`.            |
| `sourceArchive`       | —                    | Add complete sources in a private archive outside Memories; defaults to false. |
| `expectedWorkspaceId` | —                    | Refuse writes when `get-self` does not match this workspace.                   |
| `codexPath`           | `CODEX_PATH`         | Codex executable. Defaults to `codex`.                                         |
| `mcpServer`           | `NOTION_MCP_SERVER`  | Codex MCP server to use. Defaults to the one named `notion`.                   |

## Manual commands

Run from this directory, or from the installed plugin root with `src/main.ts`:

```sh
npm run preview   # offline: the memories the plugin would write
npm run sync      # write now
npm run status    # memories the plugin manages
node plugin/src/main.ts inventory  # archive source paths, sizes and SHA-256; no contents
node plugin/src/main.ts verify     # read every archive page back and compare its payload
```

## Extension points

- **Different mapping:** change `parseCodexMemories` in `codex.ts`, for
  example to import `## General Tips` as well, or `TYPES` in `claude.ts`.
- **Another agent:** add a `MemorySource` like `codexSource` or
  `claudeSource` that parses the agent's memory files. Writing, duplicate
  checks, and edit protection stay the same.

## Verification

```sh
cd examples/codex-notion-memory
npm install
npm run check
npm test
```

The default tests need no account, credentials, model, or external service.
They cover parsing and duplicate checks, then launch real Node processes from
a copied plugin artifact with no runtime dependencies and a path containing spaces.
The app-server stand-in stores synthetic pages across process restarts. Tests
exercise concurrent syncs, external edits/deletions, detached hooks, watching a
synthetic SQLite consolidation job, missing runtime binaries, unauthorized or
disconnected servers, and disabled memories with retained files.

Claude Code gets the same treatment against a local stand-in for
mcp.notion.com (OAuth refresh and Streamable HTTP MCP over the same synthetic
pages): the copied artifact's manifest and hooks, hook commands run exactly as
written in `claude-hooks.json`, restarts, concurrent syncs, Notion edits and
deletions, the auto memory switch (env, user, and project settings), missing
memories or sign-in, expired sign-in, tool errors, an unreachable server, a
custom `autoMemoryDirectory`, and the `login` flow itself.

To also install through the real Codex CLI and call a local MCP stand-in:

```sh
CODEX_TEST_BINARY="$(command -v codex)" npm test
```

That test uses an empty, temporary `CODEX_HOME`, installs through the supported
marketplace CLI, checks the installed cache and untrusted hook status, and syncs
through the real app-server and a stdio MCP fixture. It does not copy credentials,
trust hooks, call a model, or connect to production Notion. It is explicitly skipped
when `CODEX_TEST_BINARY` is absent. To exercise the actual 60-second RPC timeout:

```sh
NOTION_TEST_SLOW=1 CODEX_TEST_BINARY="$(command -v codex)" npm test
```

To install through the real Claude Code CLI into an empty, temporary
`CLAUDE_CONFIG_DIR`, check that it loads no plugin MCP server, and run the
installed cache's `SessionStart` hook against the local stand-in:

```sh
CLAUDE_TEST_BINARY="$(command -v claude)" npm test
```

The dedicated GitHub workflow runs both runtime tests, with Codex CLI 0.149.1
and Claude Code 2.1.296, on Node 22.18.0 and 22.23.4. This is runtime integration coverage, not desktop UI E2E.
Desktop installation prompts, OAuth consent, and trust/decline clicks still need
a separately permitted UI test environment. Fresh OAuth and live Notion tests
are deliberately excluded from account-free CI.

For a live test, use only a dedicated test workspace or an explicitly authorized
development connection, preview synthetic input first, verify the workspace ID,
and verify only pages created by that run. Never seed CI with personal memories
or copy OAuth credentials. Treat read/auth failures as blockers rather than
switching to another connection or a replacement authentication client.

## Troubleshooting

- **Nothing imported:** run `npm run preview`. An empty list means Codex has
  not written memories yet. Check `[features] memories = true` and give it
  time.
- **`no connected Notion server` in the log:** connect Notion in Codex. For
  the bundled MCP server, run `codex mcp login notion` and check `codex mcp list`.
- **`spawn codex ENOENT` in the log:** set `codexPath` to the full path of the
  Codex executable.
- **`Notion Memories are not available`:** the connected workspace does not
  offer Memories to MCP clients yet.
- **Hooks never run:** the log has no `hook` lines. Restart Codex and trust the
  Notion Memory hooks when it asks you to review them.
