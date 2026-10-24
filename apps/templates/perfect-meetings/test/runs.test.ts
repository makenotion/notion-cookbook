import { describe, expect, it, vi } from "vitest"

import type { Notion } from "../src/lib/props.js"
import { finishRun, isRunRequest, startRun } from "../src/workflows/lib/runs.js"

const withTrigger = (name: string | null) => ({
  object: "page",
  id: "row",
  properties: { Trigger: { select: name === null ? null : { name } } },
})

describe("isRunRequest", () => {
  it.each([
    [null, true],
    ["Run now", true],
    ["Hourly", false],
    ["Calendar event", false],
    ["Manual", false],
  ])("Trigger %s -> %s", async (trigger, expected) => {
    const retrieve = vi.fn().mockResolvedValue(withTrigger(trigger))
    const notion = { pages: { retrieve } } as unknown as Notion
    expect(await isRunRequest(notion, "row")).toBe(expected)
  })
})

describe("startRun", () => {
  const run = {
    trigger: "Hourly" as const,
    runId: "run-1",
    startedAt: "2026-09-29T17:00:00.000Z",
  }

  it("logs a new row for automatic triggers", async () => {
    const create = vi.fn().mockResolvedValue({ id: "new-row" })
    const notion = { pages: { create } } as unknown as Notion
    const id = await startRun(notion, "runs-ds", {
      ...run,
      requestPageId: null,
    })
    expect(id).toBe("new-row")
    const args = create.mock.calls[0]![0]
    expect(args.parent).toEqual({ data_source_id: "runs-ds" })
    expect(args.properties.Name.title[0].text.content).toBe("Hourly")
    expect(args.properties.Status).toEqual({ select: { name: "Pending" } })
    expect(args.properties.Trigger).toEqual({ select: { name: "Hourly" } })
  })

  it("fills in the requested row without renaming it", async () => {
    const update = vi.fn().mockResolvedValue({})
    const create = vi.fn()
    const notion = { pages: { update, create } } as unknown as Notion
    const id = await startRun(notion, "runs-ds", {
      ...run,
      trigger: "Run now",
      requestPageId: "row",
    })
    expect(id).toBe("row")
    expect(create).not.toHaveBeenCalled()
    const args = update.mock.calls[0]![0]
    expect(args.page_id).toBe("row")
    expect(args.properties.Name).toBeUndefined()
    expect(args.properties["Run ID"].rich_text[0].text.content).toBe("run-1")
  })
})

describe("finishRun", () => {
  it("records the status, finish time, and a truncated error", async () => {
    const update = vi.fn().mockResolvedValue({})
    const notion = { pages: { update } } as unknown as Notion
    await finishRun(notion, "row", "Failed", "x".repeat(5000))
    const { properties } = update.mock.calls[0]![0]
    expect(properties.Status).toEqual({ select: { name: "Failed" } })
    expect(properties.Finished.date.start).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(properties.Error.rich_text[0].text.content).toHaveLength(2000)
  })
})
