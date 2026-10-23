---
name: notion-memory
description: Write Codex memories to Notion Memories on demand, preview what would be written, or show which memories the plugin manages. Use when the user asks to sync, save, or check their Codex memories in Notion.
---

# Notion Memory

The plugin already works automatically: after Codex updates its memory files in
`~/.codex/memories/`, a hook worker writes them to the user's Notion Memories
through the Notion MCP server that Codex is signed in to.

Use the bundled entrypoint for manual actions. Resolve `src/main.ts` relative to
this skill's plugin root (two directories up from this file). It needs Node.js
22.18 or newer.

- Write Codex memories now: `node <plugin-root>/src/main.ts sync`
- Preview what would be written, without calling Notion:
  `node <plugin-root>/src/main.ts preview`
- Show the memories the plugin manages: `node <plugin-root>/src/main.ts status`

`sync` prints counts. `changedInNotion` memories were edited or deleted in
Notion and are left alone on purpose. `skippedExisting` memories already had a
memory with the same title.

If `sync` reports no connected Notion MCP server, ask the user to run
`codex mcp login notion`. If `preview` returns an empty list, Codex memories are
probably off: they need `[features] memories = true` in `~/.codex/config.toml`.
