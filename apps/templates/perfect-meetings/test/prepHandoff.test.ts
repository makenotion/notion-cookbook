import { describe, expect, it, vi } from "vitest"
import { prop } from "../src/lib/props.js"
import { prepConnections, runPrep } from "../src/workflows/lib/prep.js"

/** API-style plain_text values for the in-memory page store. */
function readable(properties: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(properties).map(([key, raw]) => {
      const value = raw as Record<string, unknown>
      for (const field of ["rich_text", "title"]) {
        if (Array.isArray(value[field])) {
          value[field] = value[field].map(
            (part: { text: { content: string } }) => ({
              plain_text: part.text.content,
            })
          )
        }
      }
      return [key, value]
    })
  )
}

function fixture(failAfterClaim = false) {
  const properties: Record<string, unknown> = readable({
    Title: prop.title("Intro"),
    When: prop.date("2099-10-01T12:00:00Z", "2099-10-01T13:00:00Z"),
    Status: prop.select("Scheduled"),
    "Attendee emails": prop.text("jane@acme.example"),
    "Prep status": prop.select("Queued"),
  })
  const saved = new Map<string, unknown>()
  const steps: string[] = []
  let claimed = false
  const notion = {
    pages: {
      retrieve: vi.fn(async () => ({ id: "meeting", properties })),
      update: vi.fn(
        async ({
          properties: updates,
        }: {
          properties: Record<string, unknown>
        }) => {
          Object.assign(properties, readable(structuredClone(updates)))
          if (
            failAfterClaim &&
            !claimed &&
            (updates["Research status"] as { select?: { name: string } })
              ?.select?.name === "Ready"
          ) {
            claimed = true
            properties["Research status"] = prop.select("Researching")
            throw new Error("response lost after successful write")
          }
          return { id: "meeting", properties }
        }
      ),
    },
    dataSources: {
      query: vi.fn(async ({ data_source_id }: { data_source_id: string }) => ({
        results:
          data_source_id === "people"
            ? [
                {
                  id: "person",
                  properties: readable({
                    Name: prop.title("Jane"),
                    Email: prop.email("jane@acme.example"),
                  }),
                },
              ]
            : [],
        has_more: false,
        next_cursor: null,
      })),
    },
    sessions: { update: vi.fn(), retrieve: vi.fn(), queryEvents: vi.fn() },
  }
  const step = vi.fn(
    async (
      name: string,
      options: { key: string[] },
      fn: () => Promise<unknown>
    ) => {
      const key = JSON.stringify(options.key)
      if (saved.has(key)) return saved.get(key)
      steps.push(name)
      let value: unknown
      try {
        value = await fn()
      } catch {
        // Model a durable step retry after a lost API response.
        value = await fn()
      }
      saved.set(key, value)
      return value
    }
  )
  const context = {
    notion,
    step,
    wait: { until: vi.fn() },
    connections: {
      calendar: {
        listContacts: vi.fn(async () => ({ accounts: [] })),
        listEvents: vi.fn(async () => ({ accounts: [] })),
      },
    },
  }
  return { context, properties, steps }
}

const targets = {
  meetings: "meetings",
  people: "people",
  companies: "companies",
}

describe("meeting research handoff", () => {
  it("prepares research with only Calendar and explicitly marks email as unchecked", async () => {
    const { context, properties, steps } = fixture()
    expect(Object.keys(prepConnections)).toEqual(["calendar"])
    await runPrep(
      context as unknown as Parameters<typeof runPrep>[0],
      targets,
      "meeting",
      "created"
    )
    expect(context.connections.calendar.listContacts).toHaveBeenCalled()
    expect(context.connections.calendar.listEvents).toHaveBeenCalledTimes(3)
    expect(steps).not.toContain("Find mailbox")
    expect(steps).not.toContain("Search email")
    const stored = (
      properties["Research context"] as { rich_text: { plain_text: string }[] }
    ).rich_text
      .map((part) => part.plain_text)
      .join("")
    expect(stored).toContain("Email was not checked")
    expect(stored).not.toContain("no email with these attendees")
    expect(properties["Research status"]).toEqual(prop.select("Ready"))
  })

  it("saves complete context before Ready, returns without agent API calls or waits", async () => {
    const { context, properties, steps } = fixture()
    await runPrep(
      context as unknown as Parameters<typeof runPrep>[0],
      targets,
      "meeting",
      "created"
    )
    expect(steps.indexOf("Save research context")).toBeLessThan(
      steps.indexOf("Queue meeting research")
    )
    expect(properties["Research status"]).toEqual(prop.select("Ready"))
    expect(properties["Requested for"]).toEqual({
      rich_text: [{ plain_text: "jane@acme.example" }],
    })
    expect(properties["Prep updated"]).toBeUndefined()
    expect(properties["Prepped for"]).toBeUndefined()
    for (const fn of Object.values(context.notion.sessions))
      expect(fn).not.toHaveBeenCalled()
    expect(context.wait.until).not.toHaveBeenCalled()
    // Replaying the workflow must not publish Ready again.
    const writes = context.notion.pages.update.mock.calls.length
    await runPrep(
      context as unknown as Parameters<typeof runPrep>[0],
      targets,
      "meeting",
      "created"
    )
    expect(context.notion.pages.update).toHaveBeenCalledTimes(writes)
  })

  it("does not requeue when the Ready write succeeded and the agent already claimed it", async () => {
    const { context, properties } = fixture(true)
    await runPrep(
      context as unknown as Parameters<typeof runPrep>[0],
      targets,
      "meeting",
      "created"
    )
    expect(properties["Research status"]).toEqual(prop.select("Researching"))
    const readyWrites = context.notion.pages.update.mock.calls.filter(
      ([args]) =>
        (args.properties["Research status"] as { select?: { name: string } })
          ?.select?.name === "Ready"
    )
    expect(readyWrites).toHaveLength(1)
  })

  it("refreshes an existing request by publishing a new Ready edit", async () => {
    const { context, properties } = fixture()
    properties["Research status"] = prop.select("Researching")
    properties["Requested for"] = {
      rich_text: [{ plain_text: "jane@acme.example" }],
    }
    properties["Regenerate prep"] = prop.checkbox(true)
    await runPrep(
      context as unknown as Parameters<typeof runPrep>[0],
      targets,
      "meeting",
      "updated"
    )
    expect(properties["Research status"]).toEqual(prop.select("Ready"))
    expect(properties["Regenerate prep"]).toEqual(prop.checkbox(false))
  })
})
