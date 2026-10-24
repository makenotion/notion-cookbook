---
name: notion-memory
description: Write Codex or Claude Code memories to Notion Memories on demand, preview what would be written, or show which memories the plugin manages. Use when the user asks to sync, save, or check their Codex or Claude Code memories in Notion.
---

# Notion Memory

Codex: trusted SessionStart and Stop hooks start bounded watchers. Changes
after a watcher exits wait for the next hook or explicit sync. Topic mode
prefers `memories_v2/` when present but does not cover all retained sources. For
“all memories,” use explicitly authorized `sourceArchive` mode and run
`inventory` and `verify`; never report a topic-only projection as full coverage.
Pin the intended MCP server and `expectedWorkspaceId` before a local-only
import.

Claude Code: hooks write a memory as soon as Claude saves it, and SessionStart
and Stop catch other changes. `inventory`, `verify`, and `sourceArchive` are
Codex-only.

Use the bundled entrypoint for manual actions. Resolve `src/main.ts` relative to
this skill's plugin root (two directories up from this file). It needs Node.js
22.18 or newer. In Claude Code, prefix every command with
`NOTION_MEMORY_AGENT=claude`; in Codex, run them as shown.

- Write memories now: `node <plugin-root>/src/main.ts sync`
- Preview what would be written, without calling Notion:
  `node <plugin-root>/src/main.ts preview`
- Inventory full sources without printing their content:
  `node <plugin-root>/src/main.ts inventory`
- Read every archived source page back: `node <plugin-root>/src/main.ts verify`
- Show the memories the plugin manages: `node <plugin-root>/src/main.ts status`

`sync` prints counts. `changedInNotion` memories were edited or deleted in
Notion and are left alone on purpose. `skippedExisting` memories already had a
memory with the same title.

If `sync` fails to reach Notion: in Codex, ask the user to run
`codex mcp login notion`. In Claude Code, ask the user to run
`NOTION_MEMORY_AGENT=claude node <plugin-root>/src/main.ts login` themselves,
since it opens a browser for Notion's consent page. If `preview` returns an
empty list in Codex, Codex memories are probably off: they need
`[features] memories = true` in `~/.codex/config.toml`. In Claude Code, it means
auto memory has not saved anything under `~/.claude/projects/*/memory/` yet.
