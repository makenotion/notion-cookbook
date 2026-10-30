import assert from "node:assert/strict"
import { test } from "node:test"

import {
  findCandidateEmail,
  REFERRAL_PATTERN,
  threadKey,
  threadMarkdown,
  type MailMessage,
} from "./referral.ts"

const MAILBOX = "recruiting@acme.example"

function message(overrides: Partial<MailMessage>): MailMessage {
  return {
    messageId: "msg-1",
    date: "2026-10-30T16:00:00.000Z",
    from: { address: "sam@acme.example", name: "Sam Rivera" },
    to: [{ address: MAILBOX }],
    cc: [],
    textWithoutUrls: "",
    ...overrides,
  }
}

test("REFERRAL_PATTERN matches referral and resume words", () => {
  assert.ok(REFERRAL_PATTERN.test("Referral: Jo for Design"))
  assert.ok(REFERRAL_PATTERN.test("Attached is my résumé"))
  assert.ok(REFERRAL_PATTERN.test("RESUME attached"))
  assert.ok(!REFERRAL_PATTERN.test("Lunch on Friday?"))
})

test("threadKey drops the verification stamp", () => {
  assert.equal(threadKey("1894c2bd0f58f2b7.a83f92c1"), "1894c2bd0f58f2b7")
  assert.equal(threadKey("1894c2bd0f58f2b7"), "1894c2bd0f58f2b7")
})

test("findCandidateEmail prefers an address in the text", () => {
  const referral = message({
    cc: [{ address: "lee@acme.example" }],
    textWithoutUrls:
      "Referring Jo Park (Jo.Park@mail.example) for Design. Reply to sam@acme.example.",
  })
  assert.equal(findCandidateEmail(referral, MAILBOX), "jo.park@mail.example")
})

test("findCandidateEmail falls back to a CC", () => {
  const referral = message({
    cc: [{ address: MAILBOX }, { address: "jo@mail.example" }],
    textWithoutUrls: "Meet Jo, cc'd here.",
  })
  assert.equal(findCandidateEmail(referral, MAILBOX), "jo@mail.example")
})

test("findCandidateEmail uses the sender when they send their own resume", () => {
  const application = message({
    from: { address: "jo@mail.example" },
    textWithoutUrls: "My resume is attached.",
  })
  assert.equal(findCandidateEmail(application, MAILBOX), "jo@mail.example")
})

test("findCandidateEmail finds the original sender in a forward", () => {
  const forward = message({
    from: { address: MAILBOX },
    to: [{ address: "hiring@acme.example" }],
    textWithoutUrls:
      "FYI\n\n---------- Forwarded message ---------\nFrom: Jo Park <jo@mail.example>\nSubject: Resume",
  })
  assert.equal(findCandidateEmail(forward, MAILBOX), "jo@mail.example")
})

test("findCandidateEmail returns null when only the mailbox is involved", () => {
  const note = message({ from: { address: MAILBOX }, to: [] })
  assert.equal(findCandidateEmail(note, MAILBOX), null)
})

test("threadMarkdown lists each message with its sender and date", () => {
  assert.equal(
    threadMarkdown([
      message({ textWithoutUrls: "Referring Jo.\n" }),
      message({
        from: { address: "jo@mail.example" },
        date: "2026-10-31T09:00:00.000Z",
        textWithoutUrls: "Thanks!",
      }),
    ]),
    [
      "**From:** Sam Rivera (sam@acme.example)",
      "**Date:** 2026-10-30T16:00:00.000Z",
      "",
      "Referring Jo.",
      "",
      "---",
      "",
      "**From:** jo@mail.example",
      "**Date:** 2026-10-31T09:00:00.000Z",
      "",
      "Thanks!",
    ].join("\n")
  )
})
