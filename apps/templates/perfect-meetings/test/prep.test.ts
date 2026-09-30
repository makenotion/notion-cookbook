import { describe, expect, it } from "vitest"

import { pageIdFromEvent } from "../src/lib/notionIds.js"
import { localDay, startsOnDay } from "../src/lib/time.js"
import {
  PROFILE_HEADING,
  profileMarkdown,
  briefMarkdown,
  NOTES_HEADING,
  parseBrief,
  planBodyEdit,
  PREP_HEADING,
} from "../src/workflows/lib/brief.js"
import { isRuntimeSignal } from "../src/workflows/lib/runtime.js"
import { shouldPrep, splitEmails } from "../src/workflows/lib/prep.js"

const brief = {
  company: "Acme makes anvils.",
  role: "Jane runs engineering.",
  emails: "You discussed pricing.",
  objective: "Agree next steps.",
  people: [],
  companies: [],
}

describe("parseBrief", () => {
  it("reads JSON wrapped in prose or code fences", () => {
    const reply =
      'Here you go:\n```json\n{"company":"A","role":"B","emails":"C","objective":"D","people":[{"email":"Jane@Acme.example","role":"CTO"}],"companies":[{"domain":"acme.example","name":"Acme","summary":"Anvils."}]}\n```'
    expect(parseBrief(reply)).toEqual({
      company: "A",
      role: "B",
      emails: "C",
      objective: "D",
      people: [
        {
          email: "jane@acme.example",
          name: "",
          role: "CTO",
          roleSource: null,
          lowConfidence: false,
          responsibilities: "",
          interactions: "",
          recentPost: null,
        },
      ],
      companies: [{ domain: "acme.example", name: "Acme", summary: "Anvils." }],
    })
  })

  it("reads profile fields and keeps only an http post URL", () => {
    const person = (recentPost: unknown) =>
      parseBrief(
        JSON.stringify({
          company: "c",
          people: [
            {
              email: "d@mintlify.example",
              role: "Customer Success",
              responsibilities: "Owns onboarding.",
              interactions: "No recent email.",
              recentPost,
            },
          ],
        })
      ).people[0]
    expect(
      person({
        url: "[post](https://linkedin.com/posts/1)",
        date: "2026-09-01",
        summary: "Launch",
      })
    ).toMatchObject({
      responsibilities: "Owns onboarding.",
      interactions: "No recent email.",
      recentPost: {
        url: "https://linkedin.com/posts/1",
        date: "2026-09-01",
        summary: "Launch",
      },
    })
    expect(person({ url: "LinkedIn" })?.recentPost).toBeNull()
    expect(person(undefined)?.recentPost).toBeNull()
  })

  it("unwraps Markdown links around emails and domains", () => {
    const brief = parseBrief(
      JSON.stringify({
        company: "c",
        people: [
          { email: "[d@mintlify.com](mailto:d@mintlify.com)", role: "" },
        ],
        companies: [{ domain: "[mintlify.com](http://mintlify.com)" }],
      })
    )
    expect(brief.people[0]?.email).toBe("d@mintlify.com")
    expect(brief.companies[0]?.domain).toBe("mintlify.com")
  })

  it("reads a person's confidence", () => {
    const reply = (confidence: string) =>
      parseBrief(
        JSON.stringify({
          company: "c",
          people: [
            { email: "d@mintlify.example", role: "Engineer", confidence },
          ],
        })
      ).people[0]?.lowConfidence
    expect(reply("low")).toBe(true)
    expect(reply("high")).toBe(false)
  })

  it("rejects replies without a brief", () => {
    expect(() => parseBrief("I could not find anything.")).toThrow()
    expect(() => parseBrief('{"people": []}')).toThrow()
  })
})

describe("planBodyEdit", () => {
  const markdown = briefMarkdown(brief, "Sep 29, 2026, 7:45 AM")

  it("inserts the brief and a Notes heading into an empty page", () => {
    expect(planBodyEdit("", markdown)).toEqual({
      type: "insert",
      content: `${markdown}\n${NOTES_HEADING}\n`,
    })
  })

  it("replaces only the prep section and keeps notes", () => {
    const existing = `${PREP_HEADING}\nold brief\n---\n\n${NOTES_HEADING}\n- my notes`
    expect(planBodyEdit(existing, markdown)).toEqual({
      type: "replace",
      oldStr: `${PREP_HEADING}\nold brief\n---`,
      newStr: markdown,
    })
  })

  it("inserts a fresh section when the Notes heading was removed", () => {
    expect(planBodyEdit(`${PREP_HEADING}\nold`, markdown).type).toBe("insert")
  })

  it("keeps every section to one paragraph", () => {
    const out = briefMarkdown(
      { ...brief, company: "Line one.\n\nLine two." },
      "now"
    )
    expect(out).toContain("Line one. Line two.")
  })
})

describe("shouldPrep", () => {
  const base = {
    title: "Intro",
    start: "2026-09-29T17:00:00Z",
    end: "2026-09-29T17:30:00Z",
    status: "Scheduled",
    agenda: "",
    attendees: "jane@acme.example",
    preppedFor: "",
    regenerate: false,
    endedAt: Date.parse("2026-09-29T17:30:00Z"),
    now: Date.parse("2026-09-29T10:00:00Z"),
  }

  it("preps a new meeting once", () => {
    expect(shouldPrep("created", base)).toBe(true)
    expect(
      shouldPrep("created", { ...base, preppedFor: "jane@acme.example" })
    ).toBe(false)
  })

  it("ignores update events caused by its own writes", () => {
    expect(
      shouldPrep("updated", { ...base, preppedFor: "jane@acme.example" })
    ).toBe(false)
    expect(
      shouldPrep("updated", {
        ...base,
        preppedFor: "jane@acme.example",
        attendees: "a@b.example, jane@acme.example",
      })
    ).toBe(true)
  })

  it("honours Regenerate even for past meetings", () => {
    const past = {
      ...base,
      now: Date.parse("2026-09-30T00:00:00Z"),
      preppedFor: "jane@acme.example",
    }
    expect(shouldPrep("updated", past)).toBe(false)
    expect(shouldPrep("updated", { ...past, regenerate: true })).toBe(true)
  })

  it("force rewrites even past meetings", () => {
    expect(
      shouldPrep("force", {
        ...base,
        now: Date.parse("2026-10-05T00:00:00Z"),
        preppedFor: "jane@acme.example",
      })
    ).toBe(true)
  })

  it("never preps cancelled meetings", () => {
    expect(shouldPrep("morning", { ...base, status: "Cancelled" })).toBe(false)
  })

  it("splits the attendee key", () => {
    expect(splitEmails("A@x.example, b@y.example,")).toEqual([
      "a@x.example",
      "b@y.example",
    ])
  })
})

describe("localDay", () => {
  it("computes Los Angeles day bounds across the DST change", () => {
    const day = localDay(
      Date.parse("2026-11-01T15:00:00Z"),
      "America/Los_Angeles"
    )
    expect(day.date).toBe("2026-11-01")
    expect(new Date(day.startMs).toISOString()).toBe("2026-11-01T07:00:00.000Z")
    expect(new Date(day.endMs).toISOString()).toBe("2026-11-02T08:00:00.000Z")
  })

  it("matches all-day dates and date-times to the local day", () => {
    const day = localDay(
      Date.parse("2026-09-29T14:45:00Z"),
      "America/Los_Angeles"
    )
    expect(startsOnDay("2026-09-29", day)).toBe(true)
    expect(startsOnDay("2026-09-29T23:30:00-07:00", day)).toBe(true)
    expect(startsOnDay("2026-09-30T06:59:00Z", day)).toBe(true)
    expect(startsOnDay("2026-09-30T07:00:00Z", day)).toBe(false)
  })
})

describe("pageIdFromEvent", () => {
  it("reads the page ID from a Notion URL", () => {
    expect(
      pageIdFromEvent({
        url: "https://www.notion.so/Intro-call-1234567890abcdef1234567890abcdef?pvs=4",
      })
    ).toBe("12345678-90ab-cdef-1234-567890abcdef")
  })

  it("prefers an ID on the page record", () => {
    expect(
      pageIdFromEvent({
        url: null,
        page: { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
      })
    ).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
  })

  it("returns null without an ID", () => {
    expect(pageIdFromEvent({ url: "https://www.notion.so/" })).toBeNull()
  })
})

describe("isRuntimeSignal", () => {
  it("lets wait interrupts and deferred retries through", () => {
    const interrupt = new Error("waiting")
    interrupt.name = "WorkflowWaitInterrupt"
    expect(isRuntimeSignal(interrupt)).toBe(true)
    expect(isRuntimeSignal({ error: new Error("x") })).toBe(true)
    expect(isRuntimeSignal(new Error("real failure"))).toBe(false)
  })
})

describe("profileMarkdown", () => {
  const researched = {
    email: "d@mintlify.example",
    name: "Demarcus Lloyd",
    role: "Customer Success",
    roleSource: "https://linkedin.com/in/d",
    lowConfidence: false,
    responsibilities: "Owns onboarding.",
    interactions: "You met twice about docs.",
    recentPost: null,
  }
  const input = {
    researched,
    lowConfidence: false,
    meetings: [
      {
        title: "Docs [review]",
        start: "2026-09-12T17:00:00Z",
        url: "https://notion.example/m1",
      },
      { title: "Offsite", start: "2026-09-01", url: null },
    ],
    lookbackDays: 90,
    timeZone: "America/Los_Angeles",
  }

  it("lists sections, meetings, and the role source", () => {
    const markdown = profileMarkdown(input, "Sep 30, 2026, 1:00 PM")
    expect(markdown.startsWith(PROFILE_HEADING)).toBe(true)
    expect(markdown).toContain(
      "Owns onboarding. ([source](https://linkedin.com/in/d))"
    )
    expect(markdown).toContain(
      "- Sep 12, 2026 · [Docs \\[review\\]](https://notion.example/m1)"
    )
    expect(markdown).toContain("- Sep 1, 2026 · Offsite")
    expect(markdown).toContain("You met twice about docs.")
    expect(markdown).not.toContain("Recent post")
    expect(markdown).not.toContain("callout")
  })

  it("flags a low-confidence match and shows a recent post", () => {
    const markdown = profileMarkdown(
      {
        ...input,
        lowConfidence: true,
        meetings: [],
        researched: {
          ...researched,
          recentPost: {
            url: "https://x.example/p/1",
            date: "2026-09-20",
            summary: "Shipped AI search",
          },
        },
      },
      "now"
    )
    expect(markdown).toContain("<callout")
    expect(markdown).toContain("_No meetings in the last 90 days._")
    expect(markdown).toContain(
      "2026-09-20 · [Shipped AI search](https://x.example/p/1)"
    )
  })

  it("replaces only the profile section, keeping notes", () => {
    const existing = `${PROFILE_HEADING}\nold\n---\n## Notes\nmine`
    expect(planBodyEdit(existing, "new", PROFILE_HEADING)).toEqual({
      type: "replace",
      oldStr: `${PROFILE_HEADING}\nold\n---`,
      newStr: "new",
    })
    expect(planBodyEdit("", "new", PROFILE_HEADING)).toEqual({
      type: "insert",
      content: "new\n## Notes\n",
    })
  })
})
