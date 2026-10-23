---
name: notion-memory
description: Import Codex or Claude Code memories into Notion Memories on demand, preview what would be imported, or show which memories are synced. Use when the user asks to sync, save, or check their Codex or Claude Code memories in Notion.
---

# Notion Memory

The plugin already imports automatically: after the agent updates its memory
files, a hook worker copies them into the user's Notion Memories with Source =
Codex or Source = Claude Code.

Use the bundled entrypoint for manual actions. Resolve `src/main.ts` relative to
this skill's plugin root (two directories up from this file). It needs Node.js
22.18 or newer. In Claude Code, prefix every command with
`NOTION_MEMORY_AGENT=claude`; in Codex, run them as shown.

- Import memories now: `node <plugin-root>/src/main.ts sync`
- Preview what would be imported, without calling Notion:
  `node <plugin-root>/src/main.ts preview`
- Show the memory pages the plugin manages:
  `node <plugin-root>/src/main.ts status`

Configuration lives in `notion-memory.json` in the agent's home directory
(`~/.codex/` or `~/.claude/`, with `token` and optional `baseUrl`) or the
`NOTION_API_TOKEN` environment variable. Never print the token. If `preview`
returns an empty list in Codex, Codex memories are probably off: they need
`[features] memories = true` in `~/.codex/config.toml`. In Claude Code, it means
auto memory has not saved anything under `~/.claude/projects/*/memory/` yet.
