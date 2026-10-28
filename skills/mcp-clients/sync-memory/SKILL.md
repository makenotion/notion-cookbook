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
frequency, sources, destination and notifications. Use the host's native scheduler
for approved recurring work; this package implements no scheduler.

Use Node.js 22.18+ and the bundled `scripts/main.ts`, relative to this skill directory:

- `sync`: recursively copy every regular `*.md` file under `memories_v2/`, one file per page.
- `preview`: show the source files without connecting to Notion.
- `verify`: check current source hashes and managed Notion page readbacks.
- `status`: show the local mapping and pending-write recovery instructions.
- `use-workspace`: show the workspace the Notion connection reaches, the pinned
  workspace, and whether a mapping exists for it. No remote writes.
- `use-workspace --confirm <workspace-id>`: after the user approves that workspace,
  pin it. Refuses an ID the connection does not reach, and refuses to leave unresolved
  pending writes in the current workspace.
- `reconcile <source-path> --keep-notion <page-id>`: after explicit user approval,
  fetch and preserve that page, release the source path from future management, and
  clear its pending entry. Other paths can then sync. This sends no remote writes.
- `reconcile <source-path> --not-created`: only for an unknown create with no known
  page ID, after the user confirms in Notion that no page with that title and Source
  path exists (for example, the workspace rejected it over its block limit). It
  clears the pending entry so the next sync creates the page.

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
also needs reconciliation before retry. Run `status` for the affected path, known
page ID and recovery command. Inspect the page in the pinned workspace and obtain
explicit approval before releasing it with `reconcile`. A lost create response
requires locating the page by title and Source path first. If the user confirms no
such page exists, use `--not-created`. Otherwise, if it cannot be identified or
fetched, leave the pending entry intact and report the unresolved outcome. Never
assume on your own that the write failed, and never reset the mapping. An unresolved entry
blocks the whole sync; report the failure through the native scheduled task when
applicable. Releasing a file allows other files to sync but leaves that file
unsynced, which `verify` continues to report.

Before any import, run `use-workspace`, show the user the connected workspace name
and ID, and after approval pin it with `use-workspace --confirm`. This writes
`expectedWorkspaceId` and keeps the other settings. The `sync`, `verify`, `status`
and `reconcile` commands require the pin; `sync`, `verify` and `reconcile` check it
against the connection before accessing memory pages. When multiple Notion
connections are available, set `mcpServer` explicitly; there is no first-server
fallback. If authentication or a tool fails, stop that operation and
report it. Use the normal login flow when authorized. Keep source files untouched.

## Switching workspaces

The Notion connection decides which workspace is reachable; the pin only approves
it. Each pinned workspace keeps its own mapping, because page IDs belong to one
workspace. To switch:

1. Resolve any pending writes in the current workspace with `status`.
2. Ask the user to reconnect Notion and choose the new workspace on the consent page.
   In Codex this is the app's Notion connection, or `codex mcp logout` then
   `codex mcp login` for that server.
3. Run `use-workspace`, confirm the new workspace with the user, then
   `use-workspace --confirm <id>`.
4. Repeat first-import approval for the new destination with `preview`, then run
   `sync` and `verify`. A workspace without a mapping gets a full first import;
   switching back to a workspace reuses its mapping without duplicating pages.
5. Update the scheduled task's workspace ID after the user approves the new
   destination. Until then, a scheduled run stops at the workspace check.

Never edit or delete mappings to switch; pages in the previous workspace are left
alone.

## Recurring sync

Use the host's local scheduler after the user approves recurring execution. In
the Codex desktop app, create a local cron task with its Scheduled tool; the computer and app must be running. The Codex CLI has no
scheduler: report that, give the task body below for the desktop app, and leave
manual `sync` available.
Confirm the frequency, time zone, source root, target workspace and destination
visibility. Pin the approved workspace with `expectedWorkspaceId` and the source
with `sourceHome` in the existing config; preserve unrelated settings. Keep the
same mapping directory for the initial import and every scheduled run.

Run `sync` and `verify` once with those settings. If either fails, report the
failure before enabling recurrence. Check for a matching existing scheduled task;
update that task within the approved scope rather than create a duplicate. Keep
notification preferences in the scheduler's settings when supported.

Use this task body, filling in the verified config and mapping locations:

> Use the installed Sync Memory skill to run its bundled `sync` command with the
> environment variables `NOTION_MEMORY_CONFIG=[config path]` and
> `NOTION_MEMORY_DATA=[mapping path]` for the approved config and mapping. The
> approved source is [source root] and the target workspace is [workspace ID].
> Reuse those settings and the existing mapping. Copy the source Markdown through
> the command; do not rewrite or summarize it in the model. If the skill, config,
> workspace, or source is unavailable or differs from this approved scope, stop and
> report the problem. Preserve a pending write for reconciliation when the command
> reports an unknown outcome; do not clear state or repeat that mutation manually.
> Report the command's result, including unsupported or missing files and errors.

Read back the created task's actual prompt, local execution environment, schedule,
and notification settings. Verify a first run and an unchanged rerun before
claiming automatic sync works. Pause or remove the native task when the user
withdraws recurring authorization; changing the source or destination needs new
approval. Ordinary source additions and edits within the approved scope need no
new invocation from the user.
