import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { batchBlocks } from "../plugin/src/notion.ts"
import { renderTurn } from "../plugin/src/render.ts"
import {
  normalize,
  parseRollout,
  readRollout,
  userTurns,
} from "../plugin/src/rollout.ts"
import { sessionTitle } from "../plugin/src/sessions.ts"

// Recorded with codex-cli 0.164.0 (`codex exec`), with instructions and paths trimmed.
const FIXTURE = fileURLToPath(
  new URL("fixtures/rollout.jsonl", import.meta.url)
)

test("normalizes a real Codex rollout into session events", () => {
  const session = normalize(readRollout(FIXTURE))
  assert.equal(session.meta.session_id, "01a16a58-1864-7063-929c-73542d270cde")
  assert.equal(session.meta.cli_version, "0.164.0")

  const types = session.events.map((e) => e.type)
  assert.equal(types[0], "session.status")
  assert.equal(types.at(-1), "session.status")
  assert.ok(types.includes("agent.tool_use"))
  assert.equal(
    types.filter((t) => t === "agent.tool_use").length,
    types.filter((t) => t === "agent.tool_result").length
  )

  const ordinals = session.events.map((e) => e.source.ordinal)
  assert.deepEqual(
    ordinals,
    [...ordinals].sort((a, b) => a - b)
  )
})

test("keeps harness context out of user messages", () => {
  const session = normalize(readRollout(FIXTURE))
  const userMessages = session.events.filter(
    (e) => e.type === "user.message" && e.origin === "user"
  )
  assert.equal(userMessages.length, 1)
  assert.match(
    userMessages[0].content?.[0]?.text ?? "",
    /^There is a bug in math\.js/
  )
  assert.match(sessionTitle(session), /^There is a bug in math\.js/)
})

test("groups events into completed user turns", () => {
  const turns = userTurns(normalize(readRollout(FIXTURE)).turns)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].complete, true)
})

test("tolerates truncated or unknown lines", () => {
  const lines = parseRollout(
    '{"type":"session_meta","payload":{"id":"x"}}\n{"type":\n'
  )
  assert.equal(lines.length, 2)
  assert.equal(lines[1].type, "unparseable")
  assert.doesNotThrow(() => normalize(lines))
})

test("renders a turn into Notion blocks within request limits", () => {
  const [turn] = userTurns(normalize(readRollout(FIXTURE)).turns)
  const blocks = renderTurn(turn, 1)
  assert.deepEqual(blocks[0], { divider: {} })
  assert.ok(JSON.stringify(blocks).includes("Codex"))
  for (const batch of batchBlocks(blocks)) assert.ok(batch.length <= 100)
})

test("batches nested children so no request exceeds 100 blocks", () => {
  const nested = {
    toggle: { rich_text: [], children: Array(60).fill({ paragraph: {} }) },
  }
  const batches = batchBlocks([nested, nested, { paragraph: {} }])
  assert.deepEqual(
    batches.map((b) => b.length),
    [1, 2]
  )
})
