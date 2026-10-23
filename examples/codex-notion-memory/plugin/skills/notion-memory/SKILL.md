---
name: notion-memory
description: Write Codex or Claude Code memories to Notion Memories on demand, preview what would be written, or show which memories the plugin manages. Use when the user asks to sync, save, or check their Codex or Claude Code memories in Notion.
---

# Notion Memory

The plugin already works automatically: after the agent updates its memory
files, a hook worker writes them to the user's Notion Memories through Notion
MCP.

Use the bundled entrypoint for manual actions. Resolve `src/main.ts` relative to
this skill's plugin root (two directories up from this file). It needs Node.js
22.18 or newer. In Claude Code, prefix every command with
`NOTION_MEMORY_AGENT=claude`; in Codex, run them as shown.

- Write memories now: `node <plugin-root>/src/main.ts sync`
- Preview what would be written, without calling Notion:
  `node <plugin-root>/src/main.ts preview`
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
