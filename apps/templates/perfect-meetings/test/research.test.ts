import { describe, expect, it, vi } from "vitest"
import { prop, type Notion } from "../src/lib/props.js"
import {
  needsResearch,
  readyForResearch,
} from "../src/workflows/lib/research.js"

const text = (value: string) => ({ rich_text: [{ plain_text: value }] })

describe("profile research handoff", () => {
  it("requires an identifier and queues only never-researched rows", async () => {
    let properties: Record<string, unknown> = {}
    const update = vi.fn(async () => ({}))
    const notion = {
      pages: {
        retrieve: vi.fn(async () => ({ id: "p", properties })),
        update,
      },
    } as unknown as Notion
    await readyForResearch(notion, "p")
    expect(update).not.toHaveBeenCalled()
    properties = { Email: { email: "jane@acme.example" } }
    await readyForResearch(notion, "p")
    expect(update).toHaveBeenLastCalledWith({
      page_id: "p",
      properties: { "Research status": prop.select("Ready") },
    })
    properties = { Domain: text("acme.example") }
    await readyForResearch(notion, "p")
    expect(update).toHaveBeenCalledTimes(2)
  })

  it("does not reset Ready, Researching, Done, Failed, or legacy research", () => {
    for (const status of ["Ready", "Researching", "Done", "Failed"])
      expect(needsResearch({ "Research status": prop.select(status) })).toBe(
        false
      )
    for (const properties of [
      { "Researched at": prop.date("2026-10-01") },
      { Role: text("CTO") },
      { Confidence: prop.select("High") },
      { Summary: text("Makes widgets") },
    ])
      expect(needsResearch(properties)).toBe(false)
    expect(needsResearch({})).toBe(true)
  })

  it("recovers a created row after the Ready update failed, without duplicating it", async () => {
    const properties = { Email: { email: "jane@acme.example" } }
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValueOnce({})
    const notion = {
      pages: {
        retrieve: vi.fn(async () => ({ id: "p", properties })),
        update,
      },
    } as unknown as Notion
    await expect(readyForResearch(notion, "p")).rejects.toThrow(
      "network failure"
    )
    await readyForResearch(notion, "p")
    expect(update).toHaveBeenCalledTimes(2)
  })
})
