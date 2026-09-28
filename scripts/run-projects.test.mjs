import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cookbook-verify-"))
  mkdirSync(join(root, "scripts"))
  mkdirSync(join(root, "bin"))
  copyFileSync(
    new URL("./run-projects.mjs", import.meta.url),
    join(root, "scripts/run-projects.mjs")
  )
  const events = join(root, "events")
  writeFileSync(
    join(root, "bin/npm"),
    `#!/usr/bin/env bash
printf 'start %s\\n' "\${PWD##*/}" >> "$EVENTS"
if [[ "\${PWD##*/}" == "three" ]]; then sleep 0.3; else sleep 0.1; fi
printf 'end %s\\n' "\${PWD##*/}" >> "$EVENTS"
if [[ "\${PWD##*/}" == "$FAIL_PROJECT" ]]; then
  echo 'expected failure output'
  exit 1
fi
`
  )
  spawnSync("chmod", ["+x", join(root, "bin/npm")])
  for (const name of ["one", "two", "three"]) {
    const dir = join(root, "examples", name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "echo ok", check: "echo ok" } })
    )
    writeFileSync(join(dir, "tsconfig.json"), "{}")
  }
  return { root, events }
}

function run(root, events, stage, failProject = "") {
  return spawnSync(
    process.execPath,
    [join(root, "scripts/run-projects.mjs"), stage],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        EVENTS: events,
        FAIL_PROJECT: failProject,
        PROJECT_VERIFY_JOBS: "2",
      },
    }
  )
}

test("starts the next project when one worker finishes, without exceeding the limit", () => {
  const { root, events } = fixture()
  try {
    const result = run(root, events, "install")
    assert.equal(result.status, 0, result.stderr)
    const lines = readFileSync(events, "utf8").trim().split("\n")
    assert.deepEqual(
      new Set(lines.slice(0, 2)),
      new Set(["start one", "start three"])
    )
    assert.ok(lines.indexOf("start two") > lines.indexOf("end one"))
    assert.ok(lines.indexOf("start two") < lines.indexOf("end three"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reports a failing project and stops starting new work", () => {
  const { root, events } = fixture()
  try {
    const result = run(root, events, "typecheck", "one")
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Failed typecheck: examples\/one/)
    assert.match(result.stderr, /expected failure output/)
    assert.doesNotMatch(readFileSync(events, "utf8"), /start two/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
