import { afterEach, describe, expect, it, vi } from "vitest"
import { prop, read } from "../src/lib/props.js"
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

function fixture(failAfterClaim = false, claimStatus = "Researching") {
  const properties: Record<string, unknown> = readable({
    Title: prop.title("Intro"),
    When: prop.date("2099-10-01T12:00:00Z", "2099-10-01T13:00:00Z"),
    Status: prop.select("Scheduled"),
    "Attendee emails": prop.text("jane@acme.example"),
    "Prep status": prop.select("Queued"),
  })
  const person = readable({
    Name: prop.title("Jane"),
    Email: prop.email("jane@acme.example"),
    "Company domain": prop.text("acme.example"),
    "Research status": prop.select("Done"),
  })
  const company = readable({
    Name: prop.title("Acme"),
    Domain: prop.text("acme.example"),
    "Research status": prop.select("Done"),
  })
  const records: Record<string, Record<string, unknown>> = {
    meeting: properties,
    person,
    company,
  }
  const saved = new Map<string, unknown>()
  const steps: string[] = []
  let claimed = false
  const notion = {
    pages: {
      retrieve: vi.fn(async ({ page_id }: { page_id: string }) => ({
        id: page_id,
        properties: structuredClone(records[page_id]),
      })),
      update: vi.fn(
        async ({
          page_id,
          properties: updates,
        }: {
          page_id: string
          properties: Record<string, unknown>
        }) => {
          Object.assign(records[page_id]!, readable(structuredClone(updates)))
          if (
            failAfterClaim &&
            page_id === "meeting" &&
            !claimed &&
            (updates["Research status"] as { select?: { name: string } })
              ?.select?.name === "Ready"
          ) {
            claimed = true
            properties["Research status"] = prop.select(claimStatus)
            throw new Error("response lost after successful write")
          }
          return { id: "meeting", properties }
        }
      ),
    },
    dataSources: {
      query: vi.fn(
        async ({
          data_source_id,
          filter,
        }: {
          data_source_id: string
          filter: { email?: { equals: string }; rich_text?: { equals: string } }
        }) => ({
          results: Object.entries(records)
            .filter(
              ([id, record]) =>
                id !== "meeting" &&
                (data_source_id === "people"
                  ? read.email(record, "Email") === filter.email?.equals
                  : read.text(record, "Domain") === filter.rich_text?.equals)
            )
            .map(([id, properties]) => ({
              id,
              properties: structuredClone(properties),
            })),
          has_more: false,
          next_cursor: null,
        })
      ),
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
    wait: {
      until: vi.fn(async (_name: string, _options: unknown) => {
        throw new Error("Unexpected wait")
      }),
    },
    connections: {
      calendar: {
        targets: { meetings: { target: "meetings" } },
        listContacts: vi.fn(async () => ({ accounts: [] })),
        listEvents: vi.fn(async () => ({ accounts: [] })),
      },
    },
  }
  const waits = new Set<string>()
  const run = (reason: Parameters<typeof runPrep>[3] = "created") =>
    runPrep(
      {
        ...context,
        wait: {
          until: async (name: string, options: { key: string[] }) => {
            const key = JSON.stringify(options.key)
            if (waits.has(key)) return
            await context.wait.until(name, options)
            waits.add(key)
          },
        },
      } as unknown as Parameters<typeof runPrep>[0],
      targets,
      "meeting",
      reason
    )
  const readyWrites = () =>
    notion.pages.update.mock.calls.filter(
      ([args]) =>
        args.page_id === "meeting" &&
        read.select(args.properties, "Research status") === "Ready"
    )
  return {
    context,
    properties,
    person,
    company,
    records,
    steps,
    run,
    readyWrites,
  }
}

const targets = {
  meetings: "meetings",
  people: "people",
  companies: "companies",
}

afterEach(() => vi.restoreAllMocks())

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
    expect(context.connections.calendar.listContacts).toHaveBeenCalledWith({
      calendars: { target: "meetings" },
      queries: ["jane@acme.example"],
    })
    expect(context.connections.calendar.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ calendars: { target: "meetings" } })
    )
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

  it("saves complete context before Ready and skips waiting when profiles are complete", async () => {
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

  it.each(["Researching", "Done", "Failed"])(
    "does not requeue after a lost Ready response when the agent is already %s",
    async (status) => {
      const { context, properties } = fixture(true, status)
      await runPrep(
        context as unknown as Parameters<typeof runPrep>[0],
        targets,
        "meeting",
        "created"
      )
      expect(properties["Research status"]).toEqual(prop.select(status))
      const readyWrites = context.notion.pages.update.mock.calls.filter(
        ([args]) =>
          (args.properties["Research status"] as { select?: { name: string } })
            ?.select?.name === "Ready"
      )
      expect(readyWrites).toHaveLength(1)
    }
  )

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

describe("profile research dependency", () => {
  it("waits for both participant and company research and loads completed profiles afresh", async () => {
    const f = fixture()
    f.person["Research status"] = prop.select("Researching")
    f.company["Research status"] = prop.select("Ready")
    f.context.wait.until.mockImplementation(async () => {
      expect(f.readyWrites()).toHaveLength(0)
      expect(f.properties["Prep status"]).toEqual(prop.select("Queued"))
      if (f.context.wait.until.mock.calls.length === 1) {
        Object.assign(
          f.person,
          readable({
            "Research status": prop.select("Done"),
            Role: prop.text("Head of Design"),
          })
        )
      } else {
        Object.assign(
          f.company,
          readable({
            "Research status": prop.select("Done"),
            Name: prop.title("Acme Studio"),
          })
        )
      }
    })
    await f.run()
    expect(f.context.wait.until).toHaveBeenCalledTimes(2)
    expect(
      new Set(
        f.context.wait.until.mock.calls.map(([, options]) =>
          JSON.stringify(options)
        )
      ).size
    ).toBe(2)
    expect(f.readyWrites()).toHaveLength(1)
    expect(read.text(f.properties, "Research context")).toContain(
      "Head of Design"
    )
    expect(read.text(f.properties, "Research context")).toContain("Acme Studio")
    expect(f.properties["Prep status"]).toEqual(prop.select("Queued"))
    // A replay must not repeat the handoff or profile writes.
    const writes = f.context.notion.pages.update.mock.calls.length
    await f.run()
    expect(f.context.notion.pages.update).toHaveBeenCalledTimes(writes)
  })

  it("queues never-requested profiles once and ignores unrelated research", async () => {
    const f = fixture()
    f.person["Research status"] = { select: null }
    f.company["Research status"] = { select: null }
    f.records.unrelated = readable({
      Email: prop.email("someone@else.example"),
      "Research status": prop.select("Failed"),
    })
    f.context.wait.until.mockImplementation(async () => {
      expect(f.person["Research status"]).toEqual(prop.select("Ready"))
      expect(f.company["Research status"]).toEqual(prop.select("Ready"))
      if (f.context.wait.until.mock.calls.length === 2) {
        f.person["Research status"] = prop.select("Done")
        f.company["Research status"] = prop.select("Done")
      }
    })
    await f.run()
    expect(f.readyWrites()).toHaveLength(1)
    expect(
      f.context.notion.pages.update.mock.calls.filter(
        ([args]) => args.page_id !== "meeting"
      )
    ).toHaveLength(2)
  })

  it("accepts legacy researched profiles and a completed search with no match", async () => {
    const f = fixture()
    Object.assign(
      f.person,
      readable({
        "Research status": { select: null },
        "Researched at": prop.date("2026-10-02"),
      })
    )
    // Company is Done with no Summary: research can finish without finding facts.
    await f.run()
    expect(f.readyWrites()).toHaveLength(1)
    expect(f.context.wait.until).not.toHaveBeenCalled()
  })

  it.each(["person", "company"])(
    "fails without publishing a brief when the %s research fails",
    async (id) => {
      const f = fixture()
      f.records[id]!["Research status"] = prop.select("Failed")
      await expect(f.run()).rejects.toThrow("Profile research failed")
      expect(f.readyWrites()).toHaveLength(0)
      expect(f.properties["Prep status"]).toEqual(prop.select("Failed"))
      expect(read.text(f.properties, "Research context")).toContain(
        "retry Regenerate prep"
      )
    }
  )

  it.each(["missing person", "missing company", "unfinished research"])(
    "bounds the wait for %s",
    async (scenario) => {
      const f = fixture()
      if (scenario === "missing person") delete f.records.person
      else if (scenario === "missing company") delete f.records.company
      else f.person["Research status"] = prop.select("Researching")
      let now = Date.now()
      vi.spyOn(Date, "now").mockImplementation(() => now)
      f.context.wait.until.mockImplementation(async () => {
        now += 30_000
      })
      await expect(f.run()).rejects.toThrow("after 20 minutes")
      expect(f.context.wait.until).toHaveBeenCalledTimes(40)
      expect(f.readyWrites()).toHaveLength(0)
      expect(f.properties["Prep status"]).toEqual(prop.select("Failed"))
    }
  )

  it("resumes a durable wait without marking the meeting failed", async () => {
    const f = fixture()
    f.person["Research status"] = prop.select("Researching")
    const interrupt = new Error("suspend")
    interrupt.name = "WorkflowWaitInterrupt"
    f.context.wait.until
      .mockRejectedValueOnce(interrupt)
      .mockResolvedValue(undefined)
    await expect(f.run()).rejects.toBe(interrupt)
    expect(f.properties["Prep status"]).toEqual(prop.select("Queued"))
    expect(f.readyWrites()).toHaveLength(0)
    f.person["Research status"] = prop.select("Done")
    await f.run()
    expect(f.readyWrites()).toHaveLength(1)
  })

  it.each(["cancelled", "attendees changed", "new request", "regenerate"])(
    "discards a waiting request when %s",
    async (scenario) => {
      const f = fixture()
      f.person["Research status"] = prop.select("Researching")
      f.context.wait.until.mockImplementation(async () => {
        if (scenario === "cancelled")
          f.properties.Status = prop.select("Cancelled")
        if (scenario === "attendees changed")
          Object.assign(
            f.properties,
            readable({ "Attendee emails": prop.text("new@acme.example") })
          )
        if (scenario === "new request")
          Object.assign(
            f.properties,
            readable({ "Research context": prop.text("Newer request") })
          )
        if (scenario === "regenerate")
          f.properties["Regenerate prep"] = prop.checkbox(true)
      })
      await f.run()
      expect(f.readyWrites()).toHaveLength(0)
      expect(f.properties["Prep status"]).toEqual(prop.select("Queued"))
      if (scenario === "new request")
        expect(read.text(f.properties, "Research context")).toBe(
          "Newer request"
        )
    }
  )

  it.each(["Save research context", "Queue meeting research"])(
    "discards changed attendees immediately before %s",
    async (phase) => {
      const f = fixture()
      const execute = f.context.step.getMockImplementation()!
      f.context.step.mockImplementation(async (name, options, fn) => {
        if (name === phase)
          Object.assign(
            f.properties,
            readable({ "Attendee emails": prop.text("new@acme.example") })
          )
        return execute(name, options, fn)
      })
      await f.run()
      expect(f.readyWrites()).toHaveLength(0)
    }
  )

  it("does not overwrite a newer request when an old check fails", async () => {
    const f = fixture()
    f.person["Research status"] = prop.select("Researching")
    f.context.wait.until.mockImplementation(async () => {
      Object.assign(
        f.properties,
        readable({
          "Research context": prop.text("Newer request"),
          "Prep status": prop.select("Ready"),
        })
      )
      throw new Error("lookup failed")
    })
    await expect(f.run()).rejects.toThrow("lookup failed")
    expect(f.properties["Prep status"]).toEqual(prop.select("Ready"))
    expect(read.text(f.properties, "Research context")).toBe("Newer request")
    expect(f.readyWrites()).toHaveLength(0)
  })
})
