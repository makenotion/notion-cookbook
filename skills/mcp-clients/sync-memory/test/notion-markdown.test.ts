import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { escapeNotionTags } from "../scripts/memories.ts"
import { fixture, object } from "./support/harness.ts"

test("tag-like text outside code is escaped and code is left alone", () => {
  assert.equal(
    escapeNotionTags("x <page> </content> <br/> <!-- c --> \\<kept>\n"),
    "x \\<page> \\</content> \\<br/> \\<!-- c --> \\<kept>\n"
  )
  assert.equal(
    escapeNotionTags("a < b, x<-y, 1<2 and `<page>` or ``a `<b>` c``\n"),
    "a < b, x<-y, 1<2 and `<page>` or ``a `<b>` c``\n"
  )
  assert.equal(
    escapeNotionTags("<https://example.com> <me@example.com> <a:b c>\n"),
    "<https://example.com> <me@example.com> \\<a:b c>\n"
  )
  const fenced =
    "````md\n```js\n<page>\n```\n</content>\n````\n<page>\n~~~\n<p>\n~~~\r\n<p>\r\n"
  assert.equal(
    escapeNotionTags(fenced),
    "````md\n```js\n<page>\n```\n</content>\n````\n\\<page>\n~~~\n<p>\n~~~\r\n\\<p>\r\n"
  )
})

test("a memory with Notion tags in its text syncs as literal text", async (t) => {
  const f = fixture(t)
  f.seed()
  const name = "tags.md"
  fs.writeFileSync(
    path.join(f.home, "memories_v2", name),
    'Notion pages nest as <page url="x">Child</page>; keep `<page>`.\n'
  )
  const result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).created, 3)
  assert.match(
    String(f.pages().find((page) => page.title === name)?.content),
    /as \\<page url="x">Child\\<\/page>; keep `<page>`\.\n$/
  )
  assert.equal((await f.exec(["verify"])).code, 0)
  assert.equal(JSON.parse((await f.exec(["sync"])).stdout).unchanged, 3)
})

for (const operation of ["create", "update"]) {
  test(`content Notion rejects as invalid on ${operation} is reported and does not block other files`, async (t) => {
    const f = fixture(t)
    f.seed()
    const dir = path.join(f.home, "memories_v2")
    if (operation === "update") assert.equal((await f.exec(["sync"])).code, 0)
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "INVALID content\n")
    fs.writeFileSync(path.join(dir, "zz-after.md"), "after\n")

    const result = await f.exec(["sync"], { FIXTURE_INVALID_TEXT: "INVALID" })
    assert.equal(result.code, 0, result.stderr)
    const summary = JSON.parse(result.stdout)
    assert.deepEqual(summary.rejected, [
      { path: "MEMORY.md", reason: "Synthetic validation error" },
    ])
    assert.ok(f.pages().some((page) => page.title === "zz-after.md"))
    const state = object(JSON.parse(fs.readFileSync(f.stateFile(), "utf8")))
    assert.deepEqual(state.pending, {})
    assert.equal(
      (await f.exec(["verify"])).code,
      1,
      "a rejected file is not verified as synced"
    )

    const fixed = await f.exec(["sync"])
    assert.equal(fixed.code, 0, fixed.stderr)
    assert.deepEqual(JSON.parse(fixed.stdout).rejected, [])
    assert.equal(
      f.pages().filter((page) => page.title === "MEMORY.md").length,
      1
    )
    assert.equal((await f.exec(["verify"])).code, 0)
  })
}

test("a 400 that is not input validation still leaves an unknown outcome", async (t) => {
  const f = fixture(t)
  f.seed()
  fs.writeFileSync(path.join(f.home, "memories_v2", "MEMORY.md"), "DENIED\n")
  const result = await f.exec(["sync"], { FIXTURE_DENIED_TEXT: "DENIED" })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Unknown create outcome/)
  const [recovery] = JSON.parse((await f.exec(["status"])).stdout).recovery
  assert.equal(recovery.phase, "unknown")
})
