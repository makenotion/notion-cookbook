import { describe, expect, it } from "vitest"

import { bestName, isPlaceholderName } from "../src/lib/domains.js"
import { parseThreads, senderName } from "../src/workflows/lib/email.js"
import { contactsByEmail } from "../src/workflows/lib/ingest.js"
import {
  researchPrompt,
  withKnownNames,
  type Attendee,
} from "../src/workflows/lib/prep.js"

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

  it("labels low-confidence snapshot names and roles", () => {
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
})
