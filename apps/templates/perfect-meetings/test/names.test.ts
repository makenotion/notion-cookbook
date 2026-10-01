import { describe, expect, it } from "vitest"

import { bestName, isPlaceholderName } from "../src/lib/domains.js"
import { parseThreads, senderName } from "../src/workflows/lib/email.js"
import { contactsByEmail } from "../src/workflows/lib/ingest.js"
import {
  matchCompany,
  personUpdates,
  researchPrompt,
  withKnownNames,
  type Attendee,
} from "../src/workflows/lib/prep.js"
import { parseBrief } from "../src/workflows/lib/brief.js"

const attendee: Attendee = {
  id: "p1",
  name: "Jlee",
  email: "jlee@example.com",
  role: "",
  photo: null,
  companyDomain: "example.com",
  confidence: null,
  profiles: { linkedin: null, x: null, instagram: null, website: null },
}

const brief = {
  company: "c",
  role: "r",
  emails: "e",
  objective: "o",
  people: [
    {
      email: "jlee@example.com",
      name: "Jordan Lee (web)",
      role: "Product Designer",
      roleSource: null,
      lowConfidence: false,
      responsibilities: "",
      interactions: "",
      profiles: { linkedin: null, x: null, instagram: null, website: null },
    },
  ],
  companies: [
    {
      domain: "example.net",
      name: "Example Corp",
      summary: "Example Corp makes widgets.",
    },
  ],
}

describe("names", () => {
  it("treats email-derived names as placeholders", () => {
    expect(isPlaceholderName("Jlee", "jlee@example.com")).toBe(true)
    expect(isPlaceholderName("Jane Doe", "jane.doe@acme.example")).toBe(true)
    expect(isPlaceholderName("jane@acme.example", "jane@acme.example")).toBe(
      true
    )
    expect(isPlaceholderName("Jordan Lee", "jlee@example.com")).toBe(false)
  })

  it("picks the first real name", () => {
    expect(bestName("jlee@example.com", "Jlee", null, "Jordan Lee")).toBe(
      "Jordan Lee"
    )
    expect(bestName("jlee@example.com", "", "Jlee")).toBeNull()
  })

  it("reads sender names from fromName or the From header", () => {
    const threads = parseThreads({
      threads: [
        {
          threadId: "1",
          from: "updates@vendor.example",
          fromName: "Vendor Updates",
        },
        { threadId: "2", from: "jlee@example.com", fromName: "Jordan Lee" },
      ],
    })!
    expect(senderName(threads, "jlee@example.com")).toBe("Jordan Lee")
    const header = parseThreads({
      threads: [{ threadId: "3", from: '"Sam Patel" <spatel@example.com>' }],
    })!
    expect(senderName(header, "spatel@example.com")).toBe("Sam Patel")
    expect(senderName(header, "jlee@example.com")).toBeNull()
  })
})

describe("contactsByEmail", () => {
  it("matches primary and alternate emails", () => {
    const output = {
      accounts: [
        {
          contacts: [
            {
              email: "jordan@lee.example",
              alternateEmails: ["jlee@example.com"],
              displayName: "Jordan Lee",
              photoUrl: "https://p/1",
            },
            { email: "someone@else.example", displayName: "Someone" },
          ],
        },
      ],
    }
    expect(
      contactsByEmail(output, ["jlee@example.com", "spatel@example.com"])
    ).toEqual({
      "jlee@example.com": { name: "Jordan Lee", photoUrl: "https://p/1" },
    })
  })
})

describe("personUpdates", () => {
  const threads = parseThreads({
    threads: [
      { threadId: "2", from: "jlee@example.com", fromName: "Jordan L." },
    ],
  })!

  it("prefers contacts, then sender name, then the agent", () => {
    const withContact = personUpdates(attendee, brief, threads, {
      name: "Jordan Lee",
      photoUrl: "https://p/1",
    })
    expect(withContact).toEqual({
      Role: { rich_text: [{ text: { content: "Product Designer" } }] },
      Name: { title: [{ text: { content: "Jordan Lee" } }] },
      Photo: { url: "https://p/1" },
      Confidence: { select: { name: "High" } },
    })
    expect(personUpdates(attendee, brief, threads).Name).toEqual({
      title: [{ text: { content: "Jordan L." } }],
    })
    expect(personUpdates(attendee, brief, []).Name).toEqual({
      title: [{ text: { content: "Jordan Lee (web)" } }],
    })
  })

  it("saves a low-confidence match as Low and lets a later match replace it", () => {
    const low = {
      ...brief,
      people: [{ ...brief.people[0]!, lowConfidence: true }],
    }
    expect(personUpdates(attendee, low, [])).toEqual({
      Role: { rich_text: [{ text: { content: "Product Designer" } }] },
      Name: { title: [{ text: { content: "Jordan Lee (web)" } }] },
      Confidence: { select: { name: "Low" } },
    })
    expect(personUpdates(attendee, brief, []).Confidence).toEqual({
      select: { name: "High" },
    })

    const stored = {
      ...attendee,
      name: "Jordan Lee (web)",
      role: "Product Designer",
      confidence: "Low",
    }
    expect(personUpdates(stored, low, [])).toEqual({})
    const better = {
      ...brief,
      people: [
        { ...brief.people[0]!, name: "Jordan Lee", role: "Design Lead" },
      ],
    }
    expect(personUpdates(stored, better, [])).toEqual({
      Role: { rich_text: [{ text: { content: "Design Lead" } }] },
      Name: { title: [{ text: { content: "Jordan Lee" } }] },
      Confidence: { select: { name: "High" } },
    })
  })

  it("marks a saved role High when a confident match confirms it", () => {
    const saved = {
      ...attendee,
      name: "Jordan Lee",
      role: "Product Designer",
    }
    expect(personUpdates(saved, brief, [])).toEqual({
      Confidence: { select: { name: "High" } },
    })
  })

  it("fills in only profiles that are not saved yet", () => {
    const found = {
      ...brief,
      people: [
        {
          ...brief.people[0]!,
          profiles: {
            linkedin: "https://linkedin.com/in/new",
            x: "https://x.com/jlee",
            instagram: null,
            website: null,
          },
        },
      ],
    }
    const saved = {
      ...attendee,
      name: "Jordan Lee",
      role: "Product Designer",
      confidence: "High",
      profiles: {
        ...attendee.profiles,
        linkedin: "https://linkedin.com/in/old",
      },
    }
    expect(personUpdates(saved, found, [])).toEqual({
      X: { url: "https://x.com/jlee" },
    })
    expect(
      personUpdates({ ...saved, confidence: "Low" }, found, []).LinkedIn
    ).toEqual({ url: "https://linkedin.com/in/new" })
  })

  it("never lets a low-confidence match replace a High one", () => {
    const low = {
      ...brief,
      people: [{ ...brief.people[0]!, lowConfidence: true }],
    }
    expect(personUpdates({ ...attendee, confidence: "High" }, low, [])).toEqual(
      {}
    )
  })

  it("never replaces a name someone typed", () => {
    expect(
      personUpdates(
        { ...attendee, name: "Brian", role: "Designer" },
        brief,
        threads
      )
    ).toEqual({})
  })
})

describe("matchCompany", () => {
  it("falls back to the only company when domains differ", () => {
    expect(matchCompany({ domain: "example.com" }, 1, brief)?.name).toBe(
      "Example Corp"
    )
    expect(matchCompany({ domain: "example.com" }, 2, brief)).toBeUndefined()
  })
})

describe("research prompt names", () => {
  it("sends known names and hides placeholders", () => {
    const people = withKnownNames(
      [
        attendee,
        {
          ...attendee,
          id: "p2",
          name: "Mrivera",
          email: "mrivera@example.com",
        },
      ],
      { "jlee@example.com": { name: "Jordan Lee", photoUrl: null } },
      {}
    )
    expect(people.map((p) => p.name)).toEqual(["Jordan Lee", "Mrivera"])
    const prompt = researchPrompt(
      { title: "Offsite", start: null, end: null, agenda: "" },
      people,
      [{ id: "c", name: "Example", domain: "example.com", summary: "" }],
      {}
    )
    expect(prompt).toContain(
      '- Jordan Lee <jlee@example.com>, company at example.com (name unconfirmed, likely "Example")'
    )
    expect(prompt).toContain(
      '- (full name unknown; email handle "mrivera") <mrivera@example.com>'
    )
  })

  it("asks the researcher to recheck a low-confidence match", () => {
    const prompt = researchPrompt(
      { title: "Intro", start: null, end: null, agenda: "" },
      [
        {
          ...attendee,
          name: "Jordan Lee",
          role: "Designer",
          confidence: "Low",
        },
      ],
      [],
      {}
    )
    expect(prompt).toContain(
      '- Jordan Lee (unconfirmed; email handle "jlee") <jlee@example.com>'
    )
    expect(prompt).toContain("low-confidence role: Designer")
  })

  it("lists known profiles so the researcher skips them", () => {
    const prompt = researchPrompt(
      { title: "Intro", start: null, end: null, agenda: "" },
      [
        {
          ...attendee,
          profiles: { ...attendee.profiles, x: "https://x.com/jlee" },
        },
      ],
      [],
      {}
    )
    expect(prompt).toContain("  Known profiles: https://x.com/jlee")
  })

  it("lists past meetings with each attendee", () => {
    const prompt = researchPrompt(
      { title: "Intro", start: null, end: null, agenda: "" },
      [attendee],
      [],
      {},
      {
        "jlee@example.com": [
          {
            eventId: "e1",
            title: "Kickoff",
            start: "2026-09-12T17:00:00Z",
            calendarUrl: null,
          },
        ],
      }
    )
    expect(prompt).toContain('  Past meetings: 2026-09-12 "Kickoff"')
  })

  it("keeps an http role source and drops anything else", () => {
    const reply = (roleSource: string) =>
      parseBrief(
        JSON.stringify({
          company: "c",
          people: [{ email: "a@x.example", role: "Eng Lead", roleSource }],
        })
      )
    expect(
      reply("https://example.com/team/jordan-lee").people[0]?.roleSource
    ).toBe("https://example.com/team/jordan-lee")
    expect(reply("LinkedIn").people[0]?.roleSource).toBeNull()
  })
})
