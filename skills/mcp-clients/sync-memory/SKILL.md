---
name: sync-memory
description: Copy local memory Markdown into Notion Memories, preview the files, or verify managed pages. Use when the user asks to sync or check memory in Notion. The current source adapter requires Codex.
metadata:
  requires-client: codex
---

# Sync Memory

Before the first import, confirm the source inventory, destination workspace and
visibility, and approval to copy these files. Reuse prior explicit approval for the
same scope. The command copies the full inventory; if approval excludes a file,
stop and report the unsupported narrower scope. Authorization for one import does
not authorize recurring work. Schedule only when the user separately approves the
frequency, sources, destination and notifications. This package installs no scheduler.

Use Node.js 22.18+ and the bundled `scripts/main.ts`, relative to this skill directory:

- `sync`: recursively copy every regular `*.md` file under `memories_v2/`, one file per page.
- `preview`: show the source files without connecting to Notion.
- `verify`: check current source hashes and managed Notion page readbacks.
- `status`: show the local file-to-page mapping.

Include `rollout_summaries/` and `extensions/`. Skip `.git/` and symbolic links.
Use each file's relative path with `/` separators as its page title and mapping key.
Codex v2 normally does not generate `MEMORY.md`; copy it if present.
Put source metadata at the start of each page, followed by a separator and the
original Markdown unchanged. The metadata includes Codex, memories_v2, relative
path, filesystem birth time (null when unavailable), filesystem mtime, sync attempt
time and notion-memory as the copier. Never substitute ctime or expose absolute
source paths. No database properties are added. Source metadata changes update the
same page; unchanged text and metadata keep Synced at unchanged.
Pages use Type Notes, Source Codex and Last updated by
Codex. Updates preserve Source. This desktop-only package runs on explicit
invocation; it installs no session hooks, watcher, or background service.

Only Codex v2 is supported. Import existing Markdown even without a summary.
Report the command's unsupported and missing paths. Existing Notion edits and
deletions are protected. Missing source files leave existing pages alone. An
explicitly empty file has only the metadata preamble. This is one-way copying.
Notion may normalize imported Markdown. Verification checks saved page readbacks,
not byte-identical export. Confirmed writes with a pending readback resume by
reading the same page. If its submitted fingerprint no longer matches, stop for
reconciliation rather than adopting possible human edits. An unknown write outcome
also needs reconciliation before retry.

Use the configured Codex-owned MCP connection and pin the intended workspace for
local-only imports. If authentication or a tool fails, stop that operation and
report it. Use the normal login flow when authorized. Keep source files untouched.
