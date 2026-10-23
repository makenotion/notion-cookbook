# Codex Notion Sync

A [Codex](https://developers.openai.com/codex) plugin that saves your Codex
sessions to Notion while you work. After every turn, the plugin appends the
conversation, tool calls, and final answer to a page in a **Codex Sessions**
database and attaches the redacted raw transcript. Optionally, it also imports
the memories Codex builds about you into your Notion Memories.

Use it when you want a searchable, shareable record of agent work next to the
rest of your team's docs, or as a starting point for wiring another coding
agent's transcripts into Notion.

## What it creates

On the first sync the plugin creates a **Codex Sessions** database under the
page you configure. Each Codex session becomes one row:

| Property                           | Value                                                           |
| ---------------------------------- | --------------------------------------------------------------- |
| Name                               | First user prompt of the session                                |
| Agent, Status                      | `Codex`; `Idle`, `Running`, or `Interrupted`                    |
| Session ID, Project, Branch, Model | From the Codex session metadata                                 |
| Turns, Tool calls                  | Counts for the session so far                                   |
| Started, Last synced               | Dates                                                           |
| Transcript                         | Redacted Codex rollout (`.txt`, one JSON line per rollout item) |
| Events                             | Normalized event list (`notion.external_agent_session.v0` JSON) |

The page body gets one section per turn: your prompt, the agent's progress
notes, a toggle per command or file edit with its output, and the final answer.
Turns are appended incrementally, so a long session is never rewritten.

## Prerequisites

- Codex CLI or the Codex app with plugin support (tested with
  `codex-cli 0.164.0`).
- Node.js 22.18 or newer on the `PATH` that Codex uses. The plugin runs its
  TypeScript sources directly with Node's built-in type stripping, so there is
  no build step and no runtime dependency.
- A Notion integration token with **Read content**, **Insert content**, and
  **Update content** capabilities. Create one at
  [notion.com/my-integrations](https://www.notion.com/my-integrations).
- A Notion page shared with that integration. The plugin creates the
  **Codex Sessions** database under it.

## Setup

### 1. Configure the Notion connection

The plugin reads `~/.codex/notion-sync.json` (or `$CODEX_HOME/notion-sync.json`).
Start from the template in this directory:

```sh
cp notion-sync.example.json ~/.codex/notion-sync.json
chmod 600 ~/.codex/notion-sync.json
# Edit token and parentPageId
```

| Key            | Environment variable         | Meaning                                                                     |
| -------------- | ---------------------------- | --------------------------------------------------------------------------- |
| `token`        | `NOTION_API_TOKEN`           | Notion integration token. Required.                                         |
| `parentPageId` | `NOTION_SYNC_PARENT_PAGE_ID` | Page that will contain **Codex Sessions**. Required for integration tokens. |
| `syncMemories` | `NOTION_SYNC_MEMORIES=1`     | Import Codex memories. Experimental, off by default.                        |
| `baseUrl`      | `NOTION_API_BASE_URL`        | API origin. Defaults to `https://api.notion.com`.                           |

Environment variables win over the file. Codex hooks inherit the environment of
the Codex process, so the file is usually the simpler choice. `.env.example`
lists the same names for reference; the plugin does not load `.env` files.

### 2. Install the plugin

Add this directory as a local Codex marketplace and install the plugin from it:

```sh
git clone https://github.com/makenotion/notion-cookbook.git
codex plugin marketplace add ./notion-cookbook/examples/codex-notion-sync
codex plugin add notion-sync@notion-cookbook
```

You can also open `/plugins` inside Codex and install **Notion Sync** from the
**Notion Cookbook** marketplace.

### 3. Trust the hooks

The plugin works through two Codex hooks, `SessionStart` and `Stop`. The next
time you start Codex it asks you to review them. Trust them to enable syncing.
Codex asks again whenever the installed plugin changes, including after an
update. Until you trust them again, the hooks are skipped and Codex shows
"plugin contents changed; hook approval required". The next successful sync
catches up on the turns it missed.

### 4. Run Codex

Start a session and send a prompt. When the turn finishes, open the configured
Notion page: **Codex Sessions** now has a row for the session, and the page
body contains the turn.

Ask Codex "sync this session to Notion" or "show Notion sync status" to use the
bundled `notion-sync` skill for manual actions.

## How it works

```text
Codex turn ends
  └─ Stop hook: node plugin/src/main.ts hook stop          (returns immediately)
       └─ detached worker: node plugin/src/main.ts worker-stop
            ├─ find the rollout under ~/.codex/sessions and normalize it
            ├─ create or update the session row, upload Transcript and Events
            ├─ append newly completed turns to the page
            └─ if syncMemories: import memories, then watch for Codex updates
```

Hooks block Codex while they run, so the hook only reads the hook payload,
spawns a detached Node.js worker (`child.unref()`), and exits. The worker keeps
running after the hook returns and writes to
`~/.codex/notion-sync/notion-sync.log`. A lock directory in
`~/.codex/notion-sync/` serializes workers, so back-to-back turns never append
the same turn twice. Sync progress is stored in
`~/.codex/notion-sync/state.json`. Errors are logged and never fail the hook.

## Codex memories (experimental)

With `[features] memories = true` in `~/.codex/config.toml`, Codex builds
memories in the background: it extracts notes from idle sessions and
consolidates them into `~/.codex/memories/memory_summary.md` and `MEMORY.md`.
With `syncMemories` enabled, the plugin mirrors those files into your Notion
Memories with **Source = Codex**:

- the `User Profile` section becomes one **Profile** memory;
- each `User preferences` bullet becomes one **Preference** memory, titled with
  your own words when Codex quoted you;
- each task group in `MEMORY.md` becomes one **Work** memory with its scope,
  tasks, and reusable knowledge.

Codex has no hook for "memories updated", so the hook workers watch for it.
After `SessionStart` (up to 10 minutes) and after `Stop` (up to 5 minutes), the
worker polls every 5 seconds. It reads Codex's job table in
`~/.codex/memories_1.sqlite` read-only to see whether a memory job is running,
and hashes the two memory files. When the files change and no job is running,
it imports them. Imports are incremental: unchanged memories are skipped, a
changed memory replaces its previous page, and a memory Codex dropped is moved
to the trash. A memory page you edited in Notion is never overwritten or
removed.

Run `npm run preview-memories` to see what would be imported without calling
Notion.

> [!WARNING]
> Notion does not yet have a public API for Notion Memories. This part uses
> the `create_pages` tool of `POST /v1/tools/run` with `parent: "memory"`,
> which only accepts a token that acts as a Notion user with memories enabled.
> Integration tokens are rejected, so leave `syncMemories` off unless you know
> your token qualifies. Session sync does not depend on it.

## Privacy

Everything is redacted on your machine before upload. The redactor removes
private keys, OpenAI, Anthropic, Notion, GitHub, Slack, and AWS keys, JWTs,
bearer tokens, `*_TOKEN=`, `*_SECRET=`, `*_PASSWORD=` style assignments, the
configured Notion token, and Codex's encrypted reasoning payloads. Pattern-based
redaction cannot catch every secret: review what your sessions contain before
syncing them to a shared workspace.

## Code map

| Path                               | Purpose                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `.agents/plugins/marketplace.json` | Local Codex marketplace that lists the plugin.                           |
| `plugin/.codex-plugin/plugin.json` | Plugin manifest: hooks, skill, and display metadata.                     |
| `plugin/hooks.json`                | `SessionStart` and `Stop` hooks.                                         |
| `plugin/skills/notion-sync/`       | Skill Codex uses for manual sync and status.                             |
| `plugin/src/main.ts`               | Entrypoint: hook handling, detached workers, and manual commands.        |
| `plugin/src/rollout.ts`            | Reads Codex rollouts and normalizes them into session events and turns.  |
| `plugin/src/render.ts`             | Turns events into Notion blocks.                                         |
| `plugin/src/sessions.ts`           | Creates the database and upserts session pages.                          |
| `plugin/src/memories.ts`           | Parses Codex memory files, imports them, and watches for updates.        |
| `plugin/src/notion.ts`             | Minimal Notion API client with retries, file uploads, and block batches. |
| `plugin/src/redact.ts`             | Secret redaction.                                                        |
| `plugin/src/config.ts`             | Configuration, state, logging, and the cross-process lock.               |

The plugin uses `fetch` instead of `@notionhq/client` on purpose: Codex copies
the plugin directory into its cache without running `npm install`, so the
plugin must run with no dependencies.

## Manual commands

Run from this directory, or from the installed plugin root with `src/main.ts`:

```sh
node plugin/src/main.ts sync-session --session <codex session id>
node plugin/src/main.ts sync-memories     # needs syncMemories access
node plugin/src/main.ts preview-memories  # offline
node plugin/src/main.ts status
```

## Extension points

- **Another agent:** write a reader that turns its transcript into the
  `SessionEvent` shape in `rollout.ts`; rendering and upload stay the same.
- **Different page layout:** change `renderTurn` in `render.ts`.
- **More properties:** add them in `ensureDatabase` and `sessionProperties` in
  `sessions.ts`. Existing databases keep their schema, so add the property in
  Notion too.
- **Stricter redaction:** add patterns to `redact.ts`.

## Verification

```sh
cd examples/codex-notion-sync
npm install
npm run check
npm test
```

The tests run offline against a recorded Codex rollout and sample memory files
in `test/fixtures/`. They cover redaction, rollout normalization, block
batching, memory parsing, and incremental memory sync against an in-memory
Notion stand-in.

## Troubleshooting

- **Nothing appears in Notion:** check `~/.codex/notion-sync/notion-sync.log`.
  A `no Notion token` line means the config file was not found. A `404` usually
  means the parent page is not shared with the integration.
- **Hooks never run:** the log has no `hook stop` lines. Restart Codex and
  trust the Notion Sync hooks when it asks you to review them.
- **No memories imported:** confirm `[features] memories = true`, that
  `~/.codex/memories/` contains `memory_summary.md`, and run
  `npm run preview-memories`. Codex only writes memories for sessions that have
  been idle for a while, so the first import can take hours.
