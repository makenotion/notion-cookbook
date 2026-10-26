---
name: notion-memory
description: Copy current Codex or Claude Code memory Markdown files into Notion Memories, preview the files, or verify managed pages. Use when the user asks to sync or check Codex or Claude Code memories in Notion.
---

# Notion Memory

Use Node.js 22.18+ and the bundled `src/main.ts`, relative to this plugin root
(two directories above this skill). In Claude Code, prefix every command with
`NOTION_MEMORY_AGENT=claude`; in Codex, run them as shown.

- `sync`: copy the agent's memory files, one file per page. In Codex that is
  `memories_v2/memory_summary.md` and optional `MEMORY.md`; in Claude Code, each
  auto memory file under `~/.claude/projects/*/memory/` except the `MEMORY.md` index.
- `preview`: show the source files without connecting to Notion.
- `verify`: check current source hashes and managed Notion page readbacks.
- `status`: show the local file-to-page mapping.

Pass Markdown unchanged. Codex pages use Type Notes; Claude Code pages take Type
from the memory's frontmatter `type`. Source and Last updated by name the agent,
and updates preserve Source. In Codex, trusted SessionStart and Stop hooks start
bounded watchers; later changes wait for the next hook or explicit sync. In Claude
Code, hooks copy a memory as soon as Claude saves it, and SessionStart and Stop
catch other changes.

Codex supports only v2. If its summary is not ready, report that condition.
Existing Notion edits and deletions are protected. Missing source files leave
existing pages alone; an explicitly empty file copies empty content. This is
one-way copying.

In Codex, use the configured Codex-owned MCP connection and pin the intended
workspace for local-only imports. In Claude Code, the plugin signs in itself: if it
is not signed in, ask the user to run
`NOTION_MEMORY_AGENT=claude node <plugin-root>/src/main.ts login` themselves, since
it opens a browser for Notion's consent page. If authentication or a tool fails,
stop that operation and report it. Use the normal login flow when authorized. Keep
source files untouched.
