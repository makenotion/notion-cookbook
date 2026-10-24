# Codex Notion Memory

A [Codex](https://developers.openai.com/codex) plugin that mirrors the memories
Codex builds about you into your Notion Memories, so Notion Agent knows the
same preferences and project context that Codex learned.

This standalone plugin is distributed from Notion Cookbook through the bundled
marketplace. Its source, releases, and installation instructions live here.

It writes through [Notion MCP](https://developers.notion.com/docs/mcp), the
same tools and the same `parent: "memory"` write that the
[Notion memory setup prompt](https://developers.notion.com/prompts/setup) asks
an agent to use. The difference is who decides to write: with the prompt, the
model has to remember to save memories, and it cannot see what Codex learns in
the background. The plugin reacts to Codex's own memory updates and writes the
same result every time.

## What it does

With `[features] memories = true`, Codex extracts notes from your idle sessions
in the background and consolidates them into `~/.codex/memories/memory_summary.md`
and `MEMORY.md`. By default the plugin maps these two files into topics. Newer Codex builds use
`memories_v2/`; the plugin prefers that directory when present. Topic mode only
extracts Profile/Preference sections from a v2 summary and does not import its
rollout summaries. Use complete source archive mode below to preserve all retained
memory content. Neither mode reads session transcripts.

It follows the Notion memory guide (`notion://docs/memory`): one memory per
topic, a title that names the topic, a **Type**, the details in the page body,
and your name instead of "the user".

| Codex memory file                        | Notion memory                                           |
| ---------------------------------------- | ------------------------------------------------------- |
| `memory_summary.md` › `User Profile`     | **Role and background** (Profile)                       |
| `memory_summary.md` › `User preferences` | **Coding workflow preferences** (Preference)            |
| `MEMORY.md` › each `# Task Group`        | One **Work** memory per project: scope, tasks, know-how |

Writes are incremental and conservative:

- Unchanged memories are skipped. A memory Codex rewrote updates its page as
  one Notion revision.
- Before creating a memory, the plugin looks for an existing memory with the
  same title. If one exists, it leaves that memory alone instead of adding a
  duplicate.
- Before updating a page, it reads it back. If you edited or deleted it in
  Notion, your version wins and the plugin never touches that memory again.
- It never deletes. When Codex drops a memory, the plugin stops managing it.
- It does not change your About page.

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

### Complete source archive mode

For an explicitly authorized full import, set `sourceArchive: true` in the
plugin configuration. It mirrors every non-hidden Markdown file recursively in
both `memories/` and `memories_v2/`, including summaries, raw memories, rollout
summaries, extensions, automation notes and memory skills. It also reads every
`stage1_outputs` row from both memory SQLite databases, retaining `thread_id`,
`raw_memory`, `rollout_summary` and `rollout_slug`. Git internals, temporary files,
symlinks, job bookkeeping and usage counters are excluded. Unreadable sources
fail the import rather than silently disappearing.

Each source becomes Notes pages with deterministic keys, 4,000 Unicode code
points per page, and a full-source SHA-256. The JSON `text` field round-trips the
original text. Markdown-significant punctuation is Unicode-escaped because live
Notion conversion can otherwise remove characters even inside code blocks.
`verify` decodes and compares every payload, and fails without printing contents.
The archive preserves complete sources rather than claiming a lossy topic
projection covers all memories. Its size includes overlapping retained records.

Pin a destination for sensitive or local-only imports:

```json
{
  "mcpServer": "notion-local",
  "expectedWorkspaceId": "your-local-workspace-id",
  "sourceArchive": true
}
```

Register that server with `codex mcp add notion-local --url <local-MCP-URL>` and
complete Codex’s normal OAuth flow. An explicit server never falls back to
another connection. `get-self` checks the expected workspace on each connection.
Credentials remain with Codex. `NOTION_MEMORY_DATA` can isolate test state from
the normal mapping without copying credentials or changing real memory files.

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

## Code map

| Path                               | Purpose                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `.agents/plugins/marketplace.json` | Local Codex marketplace that lists the plugin.                          |
| `plugin/.codex-plugin/plugin.json` | Plugin manifest: hooks, MCP server, skill, and display metadata.        |
| `plugin/.mcp.json`                 | Notion MCP server, identical to the official Codex Notion plugin.       |
| `plugin/hooks.json`                | `SessionStart` and `Stop` hooks.                                        |
| `plugin/skills/notion-memory/`     | Skill Codex uses for manual imports and status.                         |
| `plugin/hook.cjs`                  | Selects the configured Node runtime before loading TypeScript.          |
| `plugin/src/archive.ts`            | Complete retained-source inventory, encoding and readback verification. |
| `plugin/src/main.ts`               | Entrypoint: hook handling, detached workers, and manual commands.       |
| `plugin/src/mcp.ts`                | Calls Notion MCP tools through `codex app-server`.                      |
| `plugin/src/memories.ts`           | Maps Codex memory files to Notion memories and writes them.             |
| `plugin/src/config.ts`             | Configuration, state, logging, and the cross-process lock.              |

The installed `plugin/package.json` declares ESM and the Node requirement.
Codex copies the plugin directory into its cache without running
`npm install`, so the plugin has no runtime dependencies.

## Configuration

Optional. `~/.codex/notion-memory.json` (or `$NOTION_MEMORY_CONFIG`):

| Key                   | Environment variable | Meaning                                                                |
| --------------------- | -------------------- | ---------------------------------------------------------------------- |
| `nodePath`            | —                    | Node executable for hooks when their inherited PATH has an older Node. |
| `sourceHome`          | —                    | Read memory sources from this Codex home; defaults to `CODEX_HOME`.    |
| `sourceArchive`       | —                    | Opt in to complete retained memory sources; defaults to false.         |
| `expectedWorkspaceId` | —                    | Refuse writes when `get-self` does not match this workspace.           |
| `codexPath`           | `CODEX_PATH`         | Codex executable. Defaults to `codex`.                                 |
| `mcpServer`           | `NOTION_MCP_SERVER`  | Codex MCP server to use. Defaults to the one named `notion`.           |

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

- **Different mapping:** change `parseCodexMemories` in `memories.ts`, for
  example to import `## General Tips` as well.
- **Another agent:** point `memoriesDir` at another agent's memory files and
  write a parser for their format. Writing, duplicate checks, and edit
  protection stay the same.

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

The dedicated GitHub workflow runs the runtime test with Codex CLI 0.149.1 on
Node 22.18.0 and 22.23.4. This is runtime integration coverage, not desktop UI E2E.
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
