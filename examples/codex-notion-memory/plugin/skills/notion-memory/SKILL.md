---
name: notion-memory
description: Import Codex memories into Notion Memories on demand, preview what would be imported, or show which memories are synced. Use when the user asks to sync, save, or check their Codex memories in Notion.
---

# Notion Memory

The plugin already imports automatically: after Codex updates its memory files
in `~/.codex/memories/`, the hook worker copies them into the user's Notion
Memories with Source = Codex.

Use the bundled entrypoint for manual actions. Resolve `src/main.ts` relative to
this skill's plugin root (two directories up from this file). It needs Node.js
22.18 or newer.

- Import Codex memories now: `node <plugin-root>/src/main.ts sync`
- Preview what would be imported, without calling Notion:
  `node <plugin-root>/src/main.ts preview`
- Show the memory pages the plugin manages:
  `node <plugin-root>/src/main.ts status`

Configuration lives in `~/.codex/notion-memory.json` (`token`, optional
`baseUrl`) or the `NOTION_API_TOKEN` environment variable. Never print the
token. If `preview` returns an empty list, Codex memories are probably off:
they need `[features] memories = true` in `~/.codex/config.toml`.
