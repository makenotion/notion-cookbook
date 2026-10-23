import assert from "node:assert/strict"
import { test } from "node:test"
import { addSecrets, redact, redactDeep } from "../plugin/src/redact.ts"

test("redacts common credential formats", () => {
  const text = [
    "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz",
    "notion ntn_abcdefghijklmnopqrstuvwxyz0123",
    "gh ghp_abcdefghijklmnopqrstuvwxyz0123",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "DB_PASSWORD: hunter22",
  ].join("\n")
  const out = redact(text)
  assert.doesNotMatch(out, /abcdefghijklmnop|hunter22/)
  assert.match(out, /\[REDACTED_NOTION_TOKEN\]/)
  assert.match(out, /Bearer \[REDACTED\]/)
})

test("redacts exact configured secrets", () => {
  addSecrets("my-custom-secret-value")
  assert.equal(redact("token is my-custom-secret-value"), "token is [REDACTED]")
})

test("redactDeep walks objects and drops encrypted reasoning", () => {
  const out = redactDeep({
    payload: {
      encrypted_content: "gAAAA...",
      output: ["sk-ant-abcdefghijklmnopqrstuvwxyz"],
    },
  })
  assert.deepEqual(out, {
    payload: { encrypted_content: "[OMITTED]", output: ["[REDACTED_API_KEY]"] },
  })
})
