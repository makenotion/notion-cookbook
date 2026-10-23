import fs from "node:fs"
import path from "node:path"
import {
  CODEX_HOME,
  type Config,
  loadState,
  log,
  type SessionState,
  saveState,
  type State,
} from "./config.ts"
import type { DatabaseResponse, NotionClient, PageResponse } from "./notion.ts"
import { redactDeep } from "./redact.ts"
import { type Block, renderTurn, rt } from "./render.ts"
import {
  type NormalizedSession,
  normalize,
  readRollout,
  type RolloutLine,
  userTurns,
} from "./rollout.ts"

export const EVENTS_SCHEMA = "notion.external_agent_session.v0"

// Upload one Codex session: upsert its row in "Codex Sessions", attach the redacted rollout
// and normalized events, and append any newly completed turns to the page body.
export async function syncSession(
  client: NotionClient,
  config: Config,
  opts: { sessionId?: string; transcriptPath?: string }
): Promise<SessionState> {
  const file =
    opts.transcriptPath && fs.existsSync(opts.transcriptPath)
      ? opts.transcriptPath
      : findRollout(opts.sessionId)
  if (!file) throw new Error(`rollout not found for session ${opts.sessionId}`)
  const lines = readRollout(file)
  const session = normalize(lines)
  const sessionId = session.meta.session_id ?? opts.sessionId
  if (!sessionId) throw new Error(`no session id in ${file}`)

  const state = loadState()
  const dataSourceId = await ensureDatabase(client, config, state)
  saveState(state)
  const entry = (state.sessions[sessionId] ||= { syncedTurns: 0 })
  const properties = await sessionProperties(client, sessionId, lines, session)
  let pageId = entry.pageId
  if (pageId) {
    await client.request("PATCH", `/v1/pages/${pageId}`, { properties })
  } else {
    const page = await client.request<PageResponse>("POST", "/v1/pages", {
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      icon: { type: "emoji", emoji: "🤖" },
      properties,
      children: headerBlocks(session),
    })
    pageId = page.id
    entry.pageId = page.id
    entry.url = page.url
    saveState(state)
  }

  const turns = userTurns(session.turns)
  const newTurns = turns.slice(entry.syncedTurns).filter((t) => t.complete)
  for (const turn of newTurns) {
    await client.appendChildren(pageId, renderTurn(turn, entry.syncedTurns + 1))
    entry.syncedTurns++
    saveState(state)
  }
  entry.lastSyncedAt = new Date().toISOString()
  entry.rollout = file
  saveState(state)
  log(
    `session ${sessionId}: ${newTurns.length} new turn(s), ${session.events.length} events -> ${entry.url}`
  )
  return entry
}

export function findRollout(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined
  const stack = [path.join(CODEX_HOME, "sessions")]
  while (stack.length) {
    const dir = stack.pop() ?? ""
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (
        entry.name.includes(sessionId) &&
        /\.jsonl(\.zst)?$/.test(entry.name)
      )
        return full
    }
  }
  return undefined
}

export function sessionTitle(session: NormalizedSession): string {
  const first = userTurns(session.turns)[0]?.events.find(
    (e) => e.type === "user.message" && e.origin === "user"
  )
  const line = (first?.content?.[0]?.text ?? "Codex session")
    .replace(/\s+/g, " ")
    .trim()
  return line.length > 80
    ? `${line.slice(0, 80).replace(/\s+\S*$/, "")}…`
    : line
}

async function sessionProperties(
  client: NotionClient,
  sessionId: string,
  lines: RolloutLine[],
  session: NormalizedSession
): Promise<Record<string, unknown>> {
  const { meta, events } = session
  const short = sessionId.slice(-12)
  // Plain-text MIME types: the File Upload API does not accept .jsonl.
  const rawName = `codex-rollout-${short}.txt`
  const eventsName = `codex-events-${short}.json`
  const raw = `${lines.map((l) => JSON.stringify(redactDeep(l))).join("\n")}\n`
  const eventsJson = JSON.stringify(
    { schema: EVENTS_SCHEMA, agent: "codex", session: meta, events },
    null,
    2
  )
  const rawId = await client.uploadFile(rawName, "text/plain", raw)
  const eventsId = await client.uploadFile(
    eventsName,
    "application/json",
    eventsJson
  )
  const status =
    [...events].reverse().find((e) => e.type === "session.status")?.status ??
    "idle"
  return {
    Name: { title: rt(sessionTitle(session)) },
    Agent: { select: { name: "Codex" } },
    Status: {
      select: {
        name:
          status === "running"
            ? "Running"
            : status === "interrupted"
              ? "Interrupted"
              : "Idle",
      },
    },
    "Session ID": { rich_text: rt(sessionId) },
    Project: { rich_text: rt(meta.cwd ? path.basename(meta.cwd) : "") },
    Branch: { rich_text: rt(meta.branch ?? "") },
    Model: { rich_text: rt(meta.model ?? "") },
    Turns: { number: userTurns(session.turns).length },
    "Tool calls": {
      number: events.filter((e) => e.type === "agent.tool_use").length,
    },
    ...(meta.started_at
      ? { Started: { date: { start: meta.started_at } } }
      : {}),
    "Last synced": { date: { start: new Date().toISOString() } },
    Transcript: {
      files: [
        { type: "file_upload", file_upload: { id: rawId }, name: rawName },
      ],
    },
    Events: {
      files: [
        {
          type: "file_upload",
          file_upload: { id: eventsId },
          name: eventsName,
        },
      ],
    },
  }
}

// Creates "AI Coding Sessions" > "Codex Sessions" the first time. With a parent page
// configured, the database goes under it; otherwise the plugin creates a workspace-level
// page, which only works for tokens that act as a user.
async function ensureDatabase(
  client: NotionClient,
  config: Config,
  state: State
): Promise<string> {
  if (state.dataSourceId) return state.dataSourceId
  let parentPageId = config.parentPageId
  if (!parentPageId) {
    const page = await client.request<PageResponse>("POST", "/v1/pages", {
      parent: { type: "workspace", workspace: true },
      icon: { type: "emoji", emoji: "🤖" },
      properties: { title: { title: rt("AI Coding Sessions") } },
      children: [
        {
          paragraph: {
            rich_text: rt(
              "Codex sessions synced by the Notion Sync plugin for Codex. Transcripts are redacted before upload."
            ),
          },
        },
      ],
    })
    parentPageId = page.id
    state.rootPageId = page.id
  }
  const db = await client.request<DatabaseResponse>("POST", "/v1/databases", {
    parent: { type: "page_id", page_id: parentPageId },
    icon: { type: "emoji", emoji: "🧠" },
    title: rt("Codex Sessions"),
    initial_data_source: {
      properties: {
        Name: { title: {} },
        Agent: { select: { options: [{ name: "Codex", color: "green" }] } },
        Status: {
          select: {
            options: [
              { name: "Idle", color: "gray" },
              { name: "Running", color: "blue" },
              { name: "Interrupted", color: "red" },
            ],
          },
        },
        "Session ID": { rich_text: {} },
        Project: { rich_text: {} },
        Branch: { rich_text: {} },
        Model: { rich_text: {} },
        Turns: { number: {} },
        "Tool calls": { number: {} },
        Started: { date: {} },
        "Last synced": { date: {} },
        Transcript: { files: {} },
        Events: { files: {} },
      },
    },
  })
  const dataSourceId = db.data_sources?.[0]?.id
  if (!dataSourceId)
    throw new Error(`no data source returned for database ${db.id}`)
  state.databaseId = db.id
  state.dataSourceId = dataSourceId
  return dataSourceId
}

function headerBlocks(session: NormalizedSession): Block[] {
  const { meta } = session
  return [
    {
      callout: {
        icon: { type: "emoji", emoji: "📁" },
        color: "gray_background",
        rich_text: [
          ...rt("cwd ", { bold: true }),
          ...rt(meta.cwd ?? "?", { code: true }),
          ...rt("   branch ", { bold: true }),
          ...rt(meta.branch ?? "-", { code: true }),
          ...rt("   codex ", { bold: true }),
          ...rt(
            `${meta.cli_version ?? "?"} (${meta.originator ?? meta.source ?? "?"})`,
            { code: true }
          ),
        ],
      },
    },
    {
      paragraph: {
        rich_text: rt(
          "Synced from Codex by Notion Sync. Secrets are redacted before upload. The redacted rollout and normalized events are attached in the Transcript and Events properties.",
          { color: "gray" }
        ),
      },
    },
  ]
}
