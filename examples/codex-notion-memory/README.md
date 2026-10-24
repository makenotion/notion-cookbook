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

With `[features] memories = true`, Codex extracts notes from your idle sessions
in the background and consolidates them into `~/.codex/memories/memory_summary.md`
and `MEMORY.md`. The plugin only reads those two files. It never reads your
session transcripts and trusts Codex to have decided what belongs in them.

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
            └─ every 5 s, up to 10 min after SessionStart / 5 min after Stop:
                 ├─ is a memory job running in ~/.codex/memories_1.sqlite? (read-only)
                 ├─ did MEMORY.md or memory_summary.md change?
                 └─ changed and no job running → import
```

The worker calls Notion MCP tools through Codex's `mcpServer/tool/call`
app-server method, on an ephemeral thread. No model runs, and ephemeral threads
are not fed back into Codex memories. The Notion connection is lazy: an empty
or unchanged import does not connect after the user name is cached.
The hook starts no worker when neither the memory directory nor database exists.
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

Writing, duplicate checks, and edit protection are the same as for Codex. The
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
  └─ NOTION_MEMORY_AGENT=claude node plugin/src/main.ts hook <event>   (returns immediately)
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
MCP endpoint.

## Code map

| Path                                | Purpose                                                           |
| ----------------------------------- | ----------------------------------------------------------------- |
| `.agents/plugins/marketplace.json`  | Local Codex marketplace that lists the plugin.                    |
| `.claude-plugin/marketplace.json`   | Local Claude Code marketplace that lists the plugin.              |
| `plugin/.codex-plugin/plugin.json`  | Codex manifest: hooks, MCP server, skill, and display metadata.   |
| `plugin/.claude-plugin/plugin.json` | Claude Code manifest.                                             |
| `plugin/codex-mcp.json`             | Notion MCP server, identical to the official Codex Notion plugin. |
| `plugin/hooks.json`                 | Codex `SessionStart` and `Stop` hooks.                            |
| `plugin/claude-hooks.json`          | Claude Code `SessionStart`, `PostToolUse`, and `Stop` hooks.      |
| `plugin/skills/notion-memory/`      | Skill both agents use for manual imports and status.              |
| `plugin/src/main.ts`                | Entrypoint: hook handling, detached workers, and manual commands. |
| `plugin/src/memories.ts`            | Writes parsed memories to Notion with duplicate checks.           |
| `plugin/src/codex.ts`               | Maps Codex memory files to memories and watches for updates.      |
| `plugin/src/claude.ts`              | Maps Claude Code auto memory files to memories.                   |
| `plugin/src/mcp.ts`                 | Calls Notion MCP tools through `codex app-server`.                |
| `plugin/src/notionMcp.ts`           | Calls Notion MCP over HTTP with its own OAuth, for Claude Code.   |
| `plugin/src/config.ts`              | Configuration, state, logging, and the cross-process lock.        |

The Codex MCP server is in `codex-mcp.json` rather than `.mcp.json` because
Claude Code loads a plugin's `.mcp.json` automatically, which would add a
second, unauthenticated Notion server to every Claude Code session.

The installed `plugin/package.json` declares ESM and the Node requirement.
Both agents copy the plugin directory into their cache without running
`npm install`, so the plugin has no runtime dependencies.

## Configuration

Optional. `~/.codex/notion-memory.json` (or `$NOTION_MEMORY_CONFIG`):

| Key         | Environment variable | Meaning                                                      |
| ----------- | -------------------- | ------------------------------------------------------------ |
| `codexPath` | `CODEX_PATH`         | Codex executable. Defaults to `codex`.                       |
| `mcpServer` | `NOTION_MCP_SERVER`  | Codex MCP server to use. Defaults to the one named `notion`. |

## Manual commands

Run from this directory, or from the installed plugin root with `src/main.ts`:

```sh
npm run preview   # offline: the memories the plugin would write
npm run sync      # write now
npm run status    # memories the plugin manages
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
