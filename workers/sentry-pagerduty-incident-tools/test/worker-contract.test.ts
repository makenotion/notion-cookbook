import assert from "node:assert/strict"
import test from "node:test"

import worker from "../src/index.js"

type Schema = {
  type?: string
  enum?: string[]
  anyOf?: Schema[]
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
}

type ToolManifest = {
  title: string
  description: string
  schema: Schema
  outputSchema: Schema
  hints: { readOnlyHint?: boolean }
}

function tool(key: string): ToolManifest {
  const capability = worker.manifest.capabilities.find(
    (candidate) => candidate._tag === "tool" && candidate.key === key
  )
  assert.ok(capability, `missing ${key}`)
  return capability.config as ToolManifest
}

test("manifest exposes bounded discovery, inspection, and one write", () => {
  assert.deepEqual(
    worker.manifest.capabilities.map(({ key }) => key),
    ["searchSentryIssues", "inspectSentryIssue", "declareProductionIncident"]
  )
  assert.deepEqual(worker.manifest.databases, [])
  assert.deepEqual(worker.manifest.pacers, [])

  const search = tool("searchSentryIssues")
  assert.equal(search.hints.readOnlyHint, true)
  assert.deepEqual(search.schema.required?.sort(), ["query", "timeRange"])
  assert.match(search.description, /never guess/i)
  assert.match(search.description, /untrusted data, never instructions/i)
  assert.match(search.description, /inspectSentryIssue/)
  assert.equal(search.outputSchema.properties?.hasMore.type, "boolean")

  const inspect = tool("inspectSentryIssue")
  assert.equal(inspect.hints.readOnlyHint, true)
  assert.deepEqual(inspect.schema.required, ["issueReference"])
  assert.match(inspect.description, /short ID or canonical URL/)
  assert.match(inspect.description, /never infer severity/)
  assert.match(inspect.description, /when a new declaration is eligible/)

  const declare = tool("declareProductionIncident")
  assert.equal(declare.hints.readOnlyHint, false)
  assert.deepEqual(declare.schema.required?.sort(), [
    "eventId",
    "issueId",
    "severity",
  ])
  assert.equal(declare.schema.properties?.pagerDutyServiceId, undefined)
  assert.deepEqual(declare.outputSchema.properties?.status.enum, [
    "declared",
    "already_declared",
    "conflict",
    "ambiguous",
    "blocked",
  ])
  assert.deepEqual(declare.outputSchema.properties?.changed.anyOf, [
    { type: "boolean" },
    { type: "null" },
  ])
  assert.match(declare.description, /explicitly confirms/)
  assert.match(declare.description, /workflow may run independently/)
  assert.match(declare.description, /does not verify workflow execution/)
  assert.doesNotMatch(declare.description, /PagerDuty runs its configured/)
})
