import fs from "node:fs"
import zlib from "node:zlib"
import { redactDeep } from "./redact.ts"

// Codex writes each session ("rollout") as JSON Lines under $CODEX_HOME/sessions. This module
// turns a rollout into session events whose names follow Notion's agent session events
// (user.message, agent.message, agent.tool_use, ...), grouped by turn.

export interface ContentPart {
  text?: string
  input_text?: string
  output_text?: string
}

export interface FileChange {
  type?: string
  unified_diff?: string
  content?: string
}

interface RolloutItem {
  type?: string
  id?: string
  content?: ContentPart[]
  phase?: string
  summary_text?: string[]
  command?: string | string[]
  cwd?: string
  exit_code?: number
  aggregated_output?: string
  changes?: Record<string, FileChange>
  status?: string
  stdout?: string
  stderr?: string
  tool?: string
  arguments?: unknown
  query?: string
  result?: unknown
}

interface RolloutPayload {
  type?: string
  id?: string
  session_id?: string
  turn_id?: string
  model?: string
  timestamp?: string
  cwd?: string
  cli_version?: string
  originator?: string
  source?: unknown
  git?: { branch?: string; commit_hash?: string; repository_url?: string }
  model_provider?: string
  duration_ms?: number
  num_turns?: number
  item?: RolloutItem
  role?: string
  content?: ContentPart[]
  phase?: string
  name?: string
  call_id?: string
  arguments?: unknown
  input?: unknown
  action?: unknown
  output?: string | ContentPart[]
  summary?: { text?: string }[]
}

export interface RolloutLine {
  type: string
  timestamp?: string
  ordinal: number
  payload?: RolloutPayload
}

export type EventType =
  | "user.message"
  | "agent.message"
  | "agent.thinking"
  | "agent.tool_use"
  | "agent.tool_result"
  | "session.status"
  | "agent.thread_context_compacted"
  | "user.rewind"

export interface SessionEvent {
  id: string
  type: EventType
  origin: "user" | "harness" | "agent"
  created_at?: string
  turn_id?: string
  source: { agent: "codex"; session_id?: string; ordinal: number }
  content?: { type: "text"; text: string }[]
  phase?: string
  summary?: string
  status?: "running" | "idle" | "interrupted"
  duration_ms?: number
  num_turns?: number
  tool_use_id?: string
  name?: string
  input?: unknown
  output?: unknown
  is_error?: boolean
  exit_code?: number
}

export interface Turn {
  turn_id: string
  started_at?: string
  complete: boolean
  events: SessionEvent[]
}

export interface SessionMeta {
  session_id?: string
  started_at?: string
  cwd?: string
  cli_version?: string
  originator?: string
  source?: string
  branch?: string
  model?: string
  model_provider?: string
}

export interface NormalizedSession {
  meta: SessionMeta
  events: SessionEvent[]
  turns: Turn[]
}

type NewEvent = Omit<
  SessionEvent,
  "id" | "created_at" | "source" | "turn_id"
> & {
  turn_id?: string
}

// Codex injects these as user-role messages; they are context from the harness, not the user.
const HARNESS_PREFIXES = [
  "<environment_context>",
  "<user_instructions>",
  "<skills_instructions>",
  "<permissions instructions>",
  "<collaboration_mode>",
  "<turn_aborted>",
  "# AGENTS.md instructions",
]

export function readRollout(file: string): RolloutLine[] {
  let buf = fs.readFileSync(file)
  if (file.endsWith(".zst")) buf = zlib.zstdDecompressSync(buf)
  return parseRollout(buf.toString("utf8"))
}

export function parseRollout(text: string): RolloutLine[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line, ordinal) => {
      try {
        return { ...JSON.parse(line), ordinal }
      } catch {
        return { type: "unparseable", ordinal }
      }
    })
}

export function normalize(lines: RolloutLine[]): NormalizedSession {
  const metaPayload =
    lines.find((l) => l.type === "session_meta")?.payload ?? {}
  const sessionId = metaPayload.session_id ?? metaPayload.id
  const events: SessionEvent[] = []
  let turnId: string | undefined
  let model: string | undefined
  // Newer Codex versions emit structured `item_completed` events; older ones only have
  // raw `response_item` lines. Use whichever the rollout has, never both.
  const hasItems = lines.some(
    (l) => l.type === "event_msg" && l.payload?.type === "item_completed"
  )

  const push = (line: RolloutLine, event: NewEvent) =>
    events.push({
      id: `${sessionId}:${line.ordinal}:${events.length}`,
      created_at: line.timestamp,
      source: { agent: "codex", session_id: sessionId, ordinal: line.ordinal },
      ...event,
      turn_id: event.turn_id ?? turnId,
    })

  for (const line of lines) {
    const p = line.payload ?? {}
    if (line.type === "turn_context") {
      turnId = p.turn_id ?? turnId
      model = p.model ?? model
    } else if (line.type === "event_msg") {
      if (p.type === "task_started") turnId = p.turn_id ?? turnId
      normalizeEventMsg(p, hasItems).forEach((e) => push(line, e))
    } else if (line.type === "response_item" && !hasItems) {
      normalizeResponseItem(p).forEach((e) => push(line, e))
    }
  }

  return {
    meta: {
      session_id: sessionId,
      started_at: metaPayload.timestamp,
      cwd: metaPayload.cwd,
      cli_version: metaPayload.cli_version,
      originator: metaPayload.originator,
      source:
        typeof metaPayload.source === "string" ? metaPayload.source : undefined,
      branch: metaPayload.git?.branch,
      model: model ?? metaPayload.model,
      model_provider: metaPayload.model_provider,
    },
    events: redactDeep(events),
    turns: redactDeep(groupTurns(events)),
  }
}

// Turns that the user started, in order. Harness-only turns are skipped.
export function userTurns(turns: Turn[]): Turn[] {
  return turns.filter(
    (t) =>
      t.turn_id !== "no-turn" &&
      t.events.some((e) => e.type === "user.message" && e.origin === "user")
  )
}

function normalizeEventMsg(p: RolloutPayload, hasItems: boolean): NewEvent[] {
  switch (p.type) {
    case "task_started":
      return [{ type: "session.status", origin: "harness", status: "running" }]
    case "task_complete":
      return [
        {
          type: "session.status",
          origin: "harness",
          status: "idle",
          turn_id: p.turn_id,
          duration_ms: p.duration_ms,
        },
      ]
    case "turn_aborted":
      return [
        {
          type: "session.status",
          origin: "harness",
          status: "interrupted",
          turn_id: p.turn_id,
        },
      ]
    case "context_compacted":
      return [{ type: "agent.thread_context_compacted", origin: "harness" }]
    case "thread_rolled_back":
      return [{ type: "user.rewind", origin: "user", num_turns: p.num_turns }]
    case "item_completed":
      return hasItems && p.item ? normalizeItem(p.item, p.turn_id) : []
    default:
      return []
  }
}

function normalizeItem(
  it: RolloutItem,
  turn_id: string | undefined
): NewEvent[] {
  switch (it.type) {
    case "UserMessage": {
      const text = textOf(it.content)
      return [
        {
          type: "user.message",
          origin: originOf(text),
          turn_id,
          content: [{ type: "text", text }],
        },
      ]
    }
    case "AgentMessage":
      return [
        {
          type: "agent.message",
          origin: "agent",
          turn_id,
          phase: it.phase,
          content: [{ type: "text", text: textOf(it.content) }],
        },
      ]
    case "Reasoning": {
      const summary = (it.summary_text ?? []).join("\n")
      return summary
        ? [{ type: "agent.thinking", origin: "agent", turn_id, summary }]
        : []
    }
    case "CommandExecution":
      return [
        {
          type: "agent.tool_use",
          origin: "agent",
          turn_id,
          tool_use_id: it.id,
          name: "exec_command",
          input: {
            command: commandText(it.command),
            cwd: String(it.cwd ?? "").replace(/^file:\/\//, ""),
          },
        },
        {
          type: "agent.tool_result",
          origin: "harness",
          turn_id,
          tool_use_id: it.id,
          is_error: it.exit_code !== 0,
          exit_code: it.exit_code,
          output: it.aggregated_output ?? "",
        },
      ]
    case "FileChange":
      return [
        {
          type: "agent.tool_use",
          origin: "agent",
          turn_id,
          tool_use_id: it.id,
          name: "apply_patch",
          input: { changes: it.changes ?? {} },
        },
        {
          type: "agent.tool_result",
          origin: "harness",
          turn_id,
          tool_use_id: it.id,
          is_error: it.status !== "completed",
          output: [it.stdout, it.stderr].filter(Boolean).join("\n"),
        },
      ]
    case "McpToolCall":
    case "WebSearch": {
      const events: NewEvent[] = [
        {
          type: "agent.tool_use",
          origin: "agent",
          turn_id,
          tool_use_id: it.id,
          name: it.tool ?? it.type,
          input: it.arguments ?? it.query ?? {},
        },
      ]
      if (it.result !== undefined)
        events.push({
          type: "agent.tool_result",
          origin: "harness",
          turn_id,
          tool_use_id: it.id,
          output: it.result,
        })
      return events
    }
    default:
      return []
  }
}

function normalizeResponseItem(p: RolloutPayload): NewEvent[] {
  if (p.type === "message") {
    const text = textOf(p.content)
    if (p.role === "user")
      return [
        {
          type: "user.message",
          origin: originOf(text),
          content: [{ type: "text", text }],
        },
      ]
    if (p.role === "assistant")
      return [
        {
          type: "agent.message",
          origin: "agent",
          phase: p.phase,
          content: [{ type: "text", text }],
        },
      ]
    return []
  }
  if (
    p.type === "function_call" ||
    p.type === "custom_tool_call" ||
    p.type === "local_shell_call"
  )
    return [
      {
        type: "agent.tool_use",
        origin: "agent",
        tool_use_id: p.call_id,
        name: p.name ?? p.type,
        input: p.arguments ?? p.input ?? p.action,
      },
    ]
  if (p.type === "function_call_output" || p.type === "custom_tool_call_output")
    return [
      {
        type: "agent.tool_result",
        origin: "harness",
        tool_use_id: p.call_id,
        output: typeof p.output === "string" ? p.output : textOf(p.output),
      },
    ]
  if (p.type === "reasoning") {
    const summary = (p.summary ?? []).map((s) => s.text ?? "").join("\n")
    return summary ? [{ type: "agent.thinking", origin: "agent", summary }] : []
  }
  return []
}

function groupTurns(events: SessionEvent[]): Turn[] {
  const turns: Turn[] = []
  const byId = new Map<string, Turn>()
  for (const event of events) {
    const id = event.turn_id ?? "no-turn"
    let turn = byId.get(id)
    if (!turn) {
      turn = { turn_id: id, events: [], complete: false }
      byId.set(id, turn)
      turns.push(turn)
    }
    turn.events.push(event)
    if (event.type === "session.status") {
      if (event.status === "running") turn.started_at = event.created_at
      else turn.complete = true
    }
  }
  return turns
}

function textOf(content: ContentPart[] | undefined): string {
  return (content ?? [])
    .map((c) => c.text ?? c.input_text ?? c.output_text ?? "")
    .join("")
}

function originOf(text: string): "user" | "harness" {
  return HARNESS_PREFIXES.some((prefix) => text.startsWith(prefix))
    ? "harness"
    : "user"
}

// Codex records shell commands as ["bash", "-lc", "<script>"]; show the script itself.
function commandText(command: string | string[] | undefined): string {
  if (!Array.isArray(command)) return String(command ?? "")
  if (command.length === 3 && /sh$/.test(command[0])) return command[2]
  return command.join(" ")
}
