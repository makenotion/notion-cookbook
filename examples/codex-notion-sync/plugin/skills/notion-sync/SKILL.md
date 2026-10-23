---
name: notion-sync
description: Sync this Codex session transcript and Codex memories to Notion on demand, or check sync status. Use when the user asks to save, upload, or sync the session or memories to Notion.
---

# Notion Sync

The plugin already syncs automatically. The `Stop` hook uploads each finished
turn of the current session to the "Codex Sessions" database in Notion, and
Codex memories are imported into the user's Notion Memories (Source = Codex)
when Codex finishes updating them.

Use the bundled entrypoint for manual actions. Resolve `src/main.ts` relative to
this skill's plugin root (two directories up from this file). It needs Node.js
22.18 or newer.

- Sync the current session now:
  `node <plugin-root>/src/main.ts sync-session --session <session id>`
- Import Codex memories now: `node <plugin-root>/src/main.ts sync-memories`
- Preview the memories that would be imported, without calling Notion:
  `node <plugin-root>/src/main.ts preview-memories`
- Show what has been synced (page URLs, memory pages):
  `node <plugin-root>/src/main.ts status`

Configuration lives in `~/.codex/notion-sync.json` (`token`, optional
`baseUrl`, optional `parentPageId`, optional `syncMemories`) or the
`NOTION_API_TOKEN` environment variable. Never print the token. Transcripts are
redacted before upload. Report the Notion page URL back to the user after a
manual sync.
