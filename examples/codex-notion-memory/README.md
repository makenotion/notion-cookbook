# Codex Notion Memory

A [Codex](https://developers.openai.com/codex) and
[Claude Code](https://code.claude.com) plugin that brings the memories your
coding agent builds about you into your Notion Memories. When the agent updates
its memories, the plugin imports them with **Source = Codex** or **Source =
Claude Code**, so Notion Agent knows the same preferences and project context
that your coding agent learned.

Use it when you work in Codex or Claude Code and Notion and want one place to
see, edit, and reuse what your agents remember about you. The same plugin
directory installs into both agents; for Claude Code, see
[Claude Code](#claude-code).

## What it does

Codex memories are written by Codex itself. With `[features] memories = true`,
Codex extracts notes from your idle sessions in the background and consolidates
them into `~/.codex/memories/memory_summary.md` and `MEMORY.md`. The plugin
never reads your session transcripts; it only reads those two files, and trusts
Codex to have decided what belongs in them.

| Codex memory file                       | Notion memory                                       |
| --------------------------------------- | --------------------------------------------------- |
| `memory_summary.md` › `User Profile`    | One **Profile** memory                              |
| `User preferences` bullets (both files) | One **Preference** memory per bullet                |
| `MEMORY.md` › each `# Task Group`       | One **Work** memory with scope, tasks, and know-how |

Preferences are titled with your own words when Codex quoted you, and a
preference that appears in both files is imported once.

Imports are incremental:

- unchanged memories are skipped;
- a memory Codex rewrote replaces its previous page;
- a memory Codex dropped is moved to the trash;
- a memory you edited in Notion is never overwritten or removed. Your edit wins.
  Notion records edit times to the minute, so an edit made in the same minute
  as the import may go unnoticed.

## Prerequisites

- Codex CLI or the Codex app with plugin support (tested with
  `codex-cli 0.164.0`).
- Codex memories turned on in `~/.codex/config.toml`:

  ```toml
  [features]
  memories = true
  ```

- Node.js 22.18 or newer on the `PATH` that Codex uses. The plugin runs its
  TypeScript sources directly with Node's built-in type stripping, so there is
  no build step and no runtime dependency.
- A Notion token that acts as you. See [Token](#token).

## Token

> [!WARNING]
> Notion does not have a public API for Notion Memories yet. The plugin uses
> the `create_pages` tool of `POST /v1/tools/run` with `parent: "memory"`, which
> writes to the Memories of the user behind the token. It only accepts a user
> connection in a workspace where personal memories are available. Internal
> integration tokens are rejected with `Personal memories require a user
connection`. Treat this recipe as a preview of that capability.

## Setup

### 1. Configure the token

The plugin reads `~/.codex/notion-memory.json` (or
`$CODEX_HOME/notion-memory.json`):

```sh
cp notion-memory.example.json ~/.codex/notion-memory.json
chmod 600 ~/.codex/notion-memory.json
# Edit token
```

| Key       | Environment variable  | Meaning                                           |
| --------- | --------------------- | ------------------------------------------------- |
| `token`   | `NOTION_API_TOKEN`    | Notion token that acts as you. Required.          |
| `baseUrl` | `NOTION_API_BASE_URL` | API origin. Defaults to `https://api.notion.com`. |

Environment variables win over the file. Codex hooks inherit the environment of
the Codex process, so the file is usually the simpler choice. `.env.example`
lists the same names for reference; the plugin does not load `.env` files.

### 2. Install the plugin

Add this directory as a local Codex marketplace and install the plugin from it:

```sh
git clone https://github.com/makenotion/notion-cookbook.git
codex plugin marketplace add ./notion-cookbook/examples/codex-notion-memory
codex plugin add notion-memory@notion-cookbook
```

You can also open `/plugins` inside Codex and install **Notion Memory** from the
**Notion Cookbook** marketplace.

### 3. Trust the hooks

The plugin works through two Codex hooks, `SessionStart` and `Stop`. The next
time you start Codex it asks you to review them. Trust them to enable imports.
Codex asks again whenever the installed plugin changes, including after an
update. Until you trust them again, the hooks are skipped and Codex shows
"plugin contents changed; hook approval required".

### 4. Preview, then use Codex

Check what would be imported, without calling Notion:

```sh
npm run preview
```

Then keep using Codex. Codex only consolidates memories from sessions that have
been idle for a while, so the first import can take hours. After it runs, open
your Notion Memories and filter by **Source = Codex**.

Ask Codex "sync my memories to Notion" to use the bundled `notion-memory` skill
for a manual import.

## How it works

Codex has no hook for "memories updated", so the plugin watches for it:

```text
SessionStart or Stop hook
  └─ node plugin/src/main.ts hook <event>          (returns immediately)
       └─ detached worker: node plugin/src/main.ts worker <event>
            ├─ import memories once (no-op when nothing changed)
            └─ every 5 s, up to 10 min after SessionStart / 5 min after Stop:
                 ├─ is a memory job running in ~/.codex/memories_1.sqlite? (read-only)
                 ├─ did MEMORY.md or memory_summary.md change?
                 └─ changed and no job running → import
```

Hooks block Codex while they run, so the hook only spawns a detached Node.js
worker (`child.unref()`) and exits. The worker keeps running after the hook
returns, even if Codex exits. If no memory job starts shortly after the hook (2
minutes after `SessionStart`, 15 seconds after `Stop`), the worker stops early.

The worker writes to `~/.codex/notion-memory/notion-memory.log`. A lock
directory in `~/.codex/notion-memory/` serializes workers, so overlapping hooks
never create the same memory twice. The mapping from Codex memory to Notion
page is stored in `~/.codex/notion-memory/state.json`. Errors are logged and
never fail the hook.

## Claude Code

Claude Code's [auto memory](https://code.claude.com/docs/en/memory) keeps one
Markdown file per memory in `~/.claude/projects/<project>/memory/`, with a
`name`, `description`, and `type` in its frontmatter. `MEMORY.md` in the same
directory is only an index, so the plugin skips it.

| Claude Code memory `type` | Notion memory                         |
| ------------------------- | ------------------------------------- |
| `user`                    | **Profile**                           |
| `feedback`                | **Preference**                        |
| `project`                 | **Work**, noting the project it is in |
| `reference`               | **Notes**                             |

Each memory file becomes one Notion memory titled with its `description`. The
import, incremental updates, and edit protection are the same as for Codex.
The plugin imports memories from every project, so review `npm run preview`
first if some projects hold memories you don't want in Notion.

### Setup

Put the token in `~/.claude/notion-memory.json` (or
`$CLAUDE_CONFIG_DIR/notion-memory.json`), with the same keys as for Codex. Then
add this directory as a local Claude Code marketplace and install the plugin:

```sh
claude plugin marketplace add ./notion-cookbook/examples/codex-notion-memory
claude plugin install notion-memory@notion-cookbook
```

Inside Claude Code, `/plugin` does the same. Restart Claude Code to load the
hooks.

### How it works

Claude Code writes memories with its own Write and Edit tools, so there is
nothing to watch:

```text
PostToolUse hook (Write|Edit on ~/.claude/projects/*/memory/*.md)
SessionStart or Stop hook
  └─ NOTION_MEMORY_AGENT=claude node plugin/src/main.ts hook <event>   (returns immediately)
       └─ detached worker: import memories once (no-op when nothing changed)
```

`PostToolUse` imports a memory as soon as Claude saves it. `SessionStart` and
`Stop` catch changes made any other way, such as a memory deleted with `rm`.
State and logs live in `~/.claude/notion-memory/`, separate from Codex's.

For manual commands, set `NOTION_MEMORY_AGENT=claude`:

```sh
NOTION_MEMORY_AGENT=claude npm run preview
```

## Code map

| Path                                | Purpose                                                           |
| ----------------------------------- | ----------------------------------------------------------------- |
| `.agents/plugins/marketplace.json`  | Local Codex marketplace that lists the plugin.                    |
| `.claude-plugin/marketplace.json`   | Local Claude Code marketplace that lists the plugin.              |
| `plugin/.codex-plugin/plugin.json`  | Codex plugin manifest: hooks, skill, and display metadata.        |
| `plugin/.claude-plugin/plugin.json` | Claude Code plugin manifest.                                      |
| `plugin/hooks.json`                 | Codex `SessionStart` and `Stop` hooks.                            |
| `plugin/claude-hooks.json`          | Claude Code `SessionStart`, `PostToolUse`, and `Stop` hooks.      |
| `plugin/skills/notion-memory/`      | Skill both agents use for manual imports and status.              |
| `plugin/src/main.ts`                | Entrypoint: hook handling, detached workers, and manual commands. |
| `plugin/src/memories.ts`            | Imports parsed memories into Notion with edit protection.         |
| `plugin/src/codex.ts`               | Parses Codex memory files and watches for Codex updates.          |
| `plugin/src/claude.ts`              | Parses Claude Code auto memory files.                             |
| `plugin/src/notion.ts`              | Minimal Notion API client with retries.                           |
| `plugin/src/config.ts`              | Configuration, state, logging, and the cross-process lock.        |

The plugin uses `fetch` instead of `@notionhq/client` on purpose: both agents
copy the plugin directory into their cache without running `npm install`, so
the plugin must run with no dependencies.

## Manual commands

Run from this directory, or from the installed plugin root with `src/main.ts`:

```sh
npm run preview   # offline: what would be imported
npm run sync      # import now
npm run status    # memory pages managed by the plugin
```

## Extension points

- **Different mapping:** change `parseSummary` and `parseMemoryFile` in
  `codex.ts`, for example to import `## General Tips` as well, or `TYPES` in
  `claude.ts`.
- **Another agent:** add a `MemorySource` like `codexSource` or `claudeSource`
  that parses the agent's memory files; the import and edit protection stay
  the same.
- **Longer or shorter watching:** adjust `WATCH` in `main.ts`.

## Verification

```sh
cd examples/codex-notion-memory
npm install
npm run check
npm test
```

The tests run offline against sample Codex memory files in
`test/fixtures/memories/` and Claude Code memory files in
`test/fixtures/claude/`. They cover parsing, de-duplication, placeholder
handling, and incremental import, including keeping a memory edited in Notion,
against an in-memory Notion stand-in.

## Troubleshooting

- **Nothing imported:** run `npm run preview`. An empty list means Codex has
  not written memories yet; check `[features] memories = true` and give it
  time.
- **Errors in the log:** check `~/.codex/notion-memory/notion-memory.log`.
  `no Notion token` means the config file was not found. `Personal memories
require a user connection` means the token is an integration token.
- **Hooks never run:** the log has no `hook` lines. Restart Codex and trust the
  Notion Memory hooks when it asks you to review them.
