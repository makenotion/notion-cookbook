---
name: notion-memory
description: Write Codex memories to Notion Memories on demand, preview what would be written, or show which memories the plugin manages. Use when the user asks to sync, save, or check their Codex memories in Notion.
---

# Notion Memory

Trusted SessionStart and Stop hooks start bounded watchers. Changes after a
watcher exits wait for the next hook or explicit sync. Only consolidated topics
from memory_summary.md and MEMORY.md become active Notion Memories. Raw extraction
records and rollout summaries never become active topics. Explicit sourceArchive
backs up retained sources under a separate private archive; it does not replace
the knowledge projection. Run inventory and verify for full-source coverage.
Pin the intended MCP server and expectedWorkspaceId for a local-only import.

A removed managed topic is moved out of Memories and its content is retracted;
this is not permanent erasure of Notion history or all archived evidence. External
Notion edits/deletions are never overwritten. Migration moves owned legacy archive
pages using persisted IDs/hashes. If authentication, readback or move fails, stop
that channel and report the error rather than using a replacement client.

Use the bundled entrypoint for manual actions. Resolve `src/main.ts` relative to
this skill's plugin root (two directories up from this file). It needs Node.js
22.18 or newer.

- Write Codex memories now: `node <plugin-root>/src/main.ts sync`
- Preview what would be written, without calling Notion:
  `node <plugin-root>/src/main.ts preview`
- Inventory full sources without printing their content:
  `node <plugin-root>/src/main.ts inventory`
- Read every archived source page back: `node <plugin-root>/src/main.ts verify`
- Show the memories the plugin manages: `node <plugin-root>/src/main.ts status`

`sync` prints counts. `changedInNotion` memories were edited or deleted in
Notion and are left alone on purpose. `skippedExisting` memories already had a
memory with the same title.

If no server is connected, identify the configured server and report its status.
Use its normal Codex login flow when authorized. An empty preview may mean no
consolidated knowledge exists; inspect source availability and feature settings
without enabling memory or generating new memories just to manufacture a test.
