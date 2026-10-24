---
name: notion-memory
description: Write Codex or Claude Code memories to Notion Memories on demand, preview what would be written, or show which memories the plugin manages. Use when the user asks to sync, save, or check their Codex or Claude Code memories in Notion.
---

# Notion Memory

Codex: trusted SessionStart and Stop hooks start bounded watchers. Changes
after a watcher exits wait for the next hook or explicit sync. Only consolidated
topics from memory_summary.md and MEMORY.md become active Notion Memories. Raw
extraction records and rollout summaries never become active topics. Explicit
sourceArchive backs up retained sources under a separate private archive; it does
not replace the knowledge projection. Run inventory and verify for full-source
coverage. Pin the intended MCP server and expectedWorkspaceId for a local-only
import.

Claude Code: hooks write a memory as soon as Claude saves it, and SessionStart
and Stop catch other changes. Each auto memory file is one topic. `inventory`,
`verify`, and `sourceArchive` are Codex-only.

A removed managed topic is moved out of Memories and its content is retracted;
this is not permanent erasure of Notion history or all archived evidence. External
Notion edits/deletions are never overwritten. Migration moves owned legacy archive
pages using persisted IDs/hashes. If authentication, readback or move fails, stop
that channel and report the error rather than using a replacement client.

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

If no server is connected, identify the configured server and report its status.
In Codex, use its normal login flow (`codex mcp login notion`) when authorized. In
Claude Code, ask the user to run
`NOTION_MEMORY_AGENT=claude node <plugin-root>/src/main.ts login` themselves,
since it opens a browser for Notion's consent page. An empty preview may mean no
consolidated knowledge exists, or in Claude Code that auto memory has not saved
anything under `~/.claude/projects/*/memory/` yet; inspect source availability
and feature settings without enabling memory or generating new memories just to
manufacture a test.
