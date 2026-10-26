---
name: notion-memory
description: Copy current Codex memory Markdown files into Notion Memories, preview the files, or verify managed pages. Use when the user asks to sync or check Codex memories in Notion.
---

# Notion Memory

Use Node.js 22.18+ and the bundled `src/main.ts`, relative to this plugin root
(two directories above this skill):

- `sync`: copy `memories_v2/memory_summary.md` and optional `MEMORY.md`, one file per page.
- `preview`: show the source files without connecting to Notion.
- `verify`: check current source hashes and managed Notion page readbacks.
- `status`: show the local file-to-page mapping.

Pass Markdown unchanged. Pages use Type Notes, Source Codex and Last updated by
Codex. Updates preserve Source. Trusted SessionStart and Stop hooks start bounded
watchers; later changes wait for the next hook or explicit sync.

Only v2 is supported. If its summary is not ready, report that condition. Existing
Notion edits and deletions are protected. Missing source files leave existing pages
alone; an explicitly empty file copies empty content. This is one-way copying.

Use the configured Codex-owned MCP connection and pin the intended workspace for
local-only imports. If authentication or a tool fails, stop that operation and
report it. Use the normal login flow when authorized. Keep source files untouched.
