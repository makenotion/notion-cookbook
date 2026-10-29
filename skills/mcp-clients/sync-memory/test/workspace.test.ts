import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fixture, object } from "./support/harness.ts"

const other = "other-workspace"

function pin(f: ReturnType<typeof fixture>) {
  return object(
    JSON.parse(fs.readFileSync(path.join(f.home, "notion-memory.json"), "utf8"))
  ).expectedWorkspaceId
}

test("switching workspaces keeps one mapping per workspace without duplicating pages", async (t) => {
  const f = fixture(t)
  f.seed()
  assert.equal((await f.exec(["sync"])).code, 0)
  const original = fs.readFileSync(f.stateFile(), "utf8")

  const probe = await f.exec(["use-workspace"], { FIXTURE_WORKSPACE: other })
  assert.equal(probe.code, 0, probe.stderr)
  assert.deepEqual(JSON.parse(probe.stdout), {
    connected: { id: other, name: `${other} name` },
    pinned: "synthetic-workspace",
    hasMapping: false,
  })
  assert.equal(pin(f), "synthetic-workspace", "probing never changes the pin")

  const switched = await f.exec(["use-workspace", "--confirm", other], {
    FIXTURE_WORKSPACE: other,
  })
  assert.equal(switched.code, 0, switched.stderr)
  assert.equal(JSON.parse(switched.stdout).hasMapping, false)
  assert.equal(pin(f), other)

  const created = await f.exec(["sync"], { FIXTURE_WORKSPACE: other })
  assert.equal(created.code, 0, created.stderr)
  assert.equal(JSON.parse(created.stdout).created, 2)
  assert.equal((await f.exec(["verify"], { FIXTURE_WORKSPACE: other })).code, 0)
  assert.equal(
    object(JSON.parse(fs.readFileSync(f.stateFile(other), "utf8"))).workspaceId,
    other
  )
  assert.equal(fs.readFileSync(f.stateFile(), "utf8"), original)

  const back = await f.exec([
    "use-workspace",
    "--confirm",
    "synthetic-workspace",
  ])
  assert.equal(back.code, 0, back.stderr)
  assert.equal(JSON.parse(back.stdout).hasMapping, true)
  const again = await f.exec(["sync"])
  assert.equal(again.code, 0, again.stderr)
  assert.equal(JSON.parse(again.stdout).unchanged, 2)
  assert.equal(f.pages().length, 4)
})

test("use-workspace refuses a workspace the connection does not reach", async (t) => {
  const f = fixture(t)
  const result = await f.exec(["use-workspace", "--confirm", other])
  assert.equal(result.code, 1)
  assert.match(
    result.stderr,
    /reaches workspace synthetic-workspace, not other-workspace/
  )
  assert.equal(pin(f), "synthetic-workspace")
})

test("use-workspace refuses to leave unresolved pending writes behind", async (t) => {
  const f = fixture(t)
  f.seed()
  const lost = await f.exec(["sync"], { FIXTURE_FAIL_ONCE: "create-response" })
  assert.equal(lost.code, 1)
  const result = await f.exec(["use-workspace", "--confirm", other], {
    FIXTURE_WORKSPACE: other,
  })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /unresolved pending writes/)
  assert.equal(pin(f), "synthetic-workspace")
  assert.equal(fs.existsSync(f.stateFile(other)), false)
})

test("a mapping is never used for a workspace it does not belong to", async (t) => {
  const f = fixture(t)
  f.seed()
  assert.equal((await f.exec(["sync"])).code, 0)
  fs.mkdirSync(path.dirname(f.stateFile(other)), { recursive: true })
  fs.copyFileSync(f.stateFile(), f.stateFile(other))
  fs.writeFileSync(
    path.join(f.home, "notion-memory.json"),
    JSON.stringify({ expectedWorkspaceId: other })
  )
  const result = await f.exec(["sync"], { FIXTURE_WORKSPACE: other })
  assert.equal(result.code, 1)
  assert.match(
    result.stderr,
    /belongs to workspace synthetic-workspace, not other-workspace/
  )
})
