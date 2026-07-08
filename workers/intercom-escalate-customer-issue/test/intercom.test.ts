import assert from "node:assert/strict"
import { test } from "node:test"

import type { RuntimeConfig } from "../src/config.js"
import {
  IntercomApiError,
  IntercomClient,
  intercomNoteDigest,
  normalizeIntercomConversationReference,
  requestIntercomJson,
  type FetchLike,
} from "../src/intercom.js"
import { EscalationError } from "../src/types.js"

const DATA_SOURCE_ID = "11111111-1111-4111-8111-111111111111"

const config: RuntimeConfig = {
  intercomToken: "secret_intercom_token",
  intercomRegion: "us",
  intercomWorkspaceId: "workspace_1",
  intercomAdminId: "admin_1",
  intercomTeamId: "team_escalations",
  intercomTagId: "tag_escalated",
  notionTicketsDataSourceId: DATA_SOURCE_ID,
  requestTimeoutMs: 8_000,
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function customerPart(
  id: string,
  createdAt: number,
  body: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    type: "conversation_part",
    id,
    part_type: "comment",
    created_at: createdAt,
    redacted: false,
    body,
    author: { type: "user", id: "contact_1" },
    ...overrides,
  }
}

function intercomConversation(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [
    customerPart("part_1", 1_700_000_001, "Oldest customer message"),
    customerPart("part_admin", 1_700_000_002, "Public support reply", {
      author: { type: "admin", id: "admin_2" },
    }),
    customerPart("part_note", 1_700_000_003, "<p>Private note</p>", {
      part_type: "note",
      author: { type: "admin", id: "admin_2" },
    }),
    customerPart("part_redacted", 1_700_000_004, "Redacted secret", {
      redacted: true,
    }),
    customerPart("part_5", 1_700_000_005, "Message five"),
    customerPart("part_6", 1_700_000_006, "Message six"),
    customerPart("part_7", 1_700_000_007, "Message seven"),
    customerPart("part_8", 1_700_000_008, "Message eight"),
    customerPart(
      "part_9",
      1_700_000_009,
      "See https://private.example/path?token=secret and email person@example.com"
    ),
    customerPart("part_10", 1_700_000_010, "x".repeat(1_500)),
  ]

  return {
    type: "conversation",
    id: "123",
    created_at: 1_700_000_000,
    updated_at: 1_700_000_100,
    state: "open",
    priority: "not_priority",
    open: true,
    waiting_since: null,
    title: "<b>Checkout failure</b>",
    source: {
      type: "conversation",
      redacted: false,
      body: "<p>Checkout fails at https://shop.example/checkout?token=secret for me@example.com</p>",
      author: { type: "contact", id: "contact_1" },
    },
    contacts: {
      type: "contact.list",
      contacts: [{ type: "contact", id: "contact_1" }],
    },
    company: { type: "company", id: "company_1" },
    team_assignee_id: "team_inbox",
    admin_assignee_id: null,
    sla_applied: { sla_status: "missed" },
    tags: {
      type: "tag.list",
      tags: [{ type: "tag", id: "tag_vip", name: "VIP" }],
    },
    conversation_parts: {
      type: "conversation_part.list",
      conversation_parts: parts,
      total_count: parts.length + 1,
    },
    ...overrides,
  }
}

function intercomClient(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>
): IntercomClient {
  const fetchFn: FetchLike = async (input, init = {}) =>
    responder(String(input), init)
  return new IntercomClient(config, {
    fetchFn,
    sleep: async () => undefined,
  })
}

test("Intercom normalizes raw, MCP-prefixed, and canonical Inbox references", () => {
  const expected = { region: "us" as const, workspaceId: "workspace_1" }
  assert.equal(normalizeIntercomConversationReference("123"), "123")
  assert.equal(
    normalizeIntercomConversationReference("conversation_123"),
    "123"
  )
  const canonical = normalizeIntercomConversationReference("conversation_123")
  assert.equal(normalizeIntercomConversationReference(canonical), canonical)
  assert.equal(
    normalizeIntercomConversationReference(
      "https://app.intercom.com/a/inbox/workspace_1/inbox/shared/all/conversation/123",
      expected
    ),
    "123"
  )

  for (const reference of [
    "https://app.intercom.com/a/inbox/workspace_2/inbox/shared/all/conversation/123",
    "https://app.eu.intercom.com/a/inbox/workspace_1/inbox/shared/all/conversation/123",
  ]) {
    assert.throws(
      () => normalizeIntercomConversationReference(reference, expected),
      (error: unknown) =>
        error instanceof EscalationError &&
        error.code === "INTERCOM_REFERENCE_MISMATCH" &&
        error.status === "conflict"
    )
  }
  for (const reference of [
    "conversation_conversation_123",
    "https://app.intercom.com/a/inbox/workspace_1/inbox/shared/all/conversation/conversation_conversation_123",
  ]) {
    assert.throws(
      () => normalizeIntercomConversationReference(reference, expected),
      (error: unknown) =>
        error instanceof EscalationError && error.code === "INVALID_INPUT"
    )
  }
})

test("Intercom parses a bounded public timeline and excludes private content", async () => {
  const client = intercomClient((url, init) => {
    assert.equal(
      url,
      "https://api.intercom.io/conversations/123?display_as=plaintext"
    )
    assert.equal(init.method, undefined)
    const headers = new Headers(init.headers)
    assert.equal(headers.get("intercom-version"), "2.15")
    assert.equal(headers.get("authorization"), "Bearer secret_intercom_token")
    return jsonResponse(intercomConversation())
  })

  const snapshot = await client.getConversation("conversation_123")

  assert.equal(snapshot.id, "123")
  assert.equal(snapshot.title, "Checkout failure")
  assert.match(
    snapshot.openingMessage ?? "",
    /https:\/\/shop\.example\/checkout/
  )
  assert.equal(snapshot.openingMessage?.includes("token=secret"), false)
  assert.equal(snapshot.openingMessage?.includes("me@example.com"), false)
  assert.match(snapshot.openingMessage ?? "", /\[email omitted\]/)
  assert.equal(snapshot.customerEvidence.length, 8)
  assert.deepEqual(
    snapshot.customerEvidence.map(({ partId }) => partId),
    [
      "part_10",
      "part_9",
      "part_8",
      "part_7",
      "part_6",
      "part_5",
      "part_admin",
      "part_1",
    ]
  )
  assert.equal(snapshot.customerEvidence[0].text.length, 1_200)
  assert.match(
    snapshot.customerEvidence[1].text,
    /https:\/\/private\.example\/path/
  )
  assert.equal(
    snapshot.customerEvidence[1].text.includes("token=secret"),
    false
  )
  assert.equal(
    snapshot.customerEvidence[1].text.includes("person@example.com"),
    false
  )
  assert.equal(snapshot.customerEvidence[6].role, "support")
  assert.equal(snapshot.evidenceTruncated, true)
  assert.equal(snapshot.partsTruncated, true)
  assert.deepEqual(snapshot.internalNoteDigests, [
    {
      partId: "part_note",
      digest: intercomNoteDigest("<p>Private note</p>"),
    },
  ])
  const exposed = JSON.stringify({
    openingMessage: snapshot.openingMessage,
    customerEvidence: snapshot.customerEvidence,
  })
  assert.match(exposed, /Public support reply/)
  assert.doesNotMatch(exposed, /Private note|Redacted secret/)
})

test("Intercom safely degrades missing, nullable, and overlong bodies", async () => {
  const missingSourceBody = intercomConversation()
  delete (missingSourceBody.source as Record<string, unknown>).body
  const missingSourceSnapshot = await intercomClient(() =>
    jsonResponse(missingSourceBody)
  ).getConversation("123")
  assert.equal(missingSourceSnapshot.openingMessage, null)

  const overlongBody = "x".repeat(40_001)
  const parts = [
    customerPart("part_missing", 1, "unused", { body: undefined }),
    customerPart("part_null", 2, "unused", { body: null }),
    customerPart("part_long", 3, overlongBody),
    customerPart("part_long_note", 4, overlongBody, {
      part_type: "note",
      author: { type: "admin", id: "admin_2" },
    }),
  ]
  const snapshot = await intercomClient(() =>
    jsonResponse(
      intercomConversation({
        source: {
          type: "conversation",
          redacted: false,
          body: overlongBody,
          author: { type: "contact", id: "contact_1" },
        },
        conversation_parts: {
          type: "conversation_part.list",
          conversation_parts: parts,
          total_count: parts.length,
        },
      })
    )
  ).getConversation("123")

  assert.equal(snapshot.openingMessage?.length, 1_200)
  assert.deepEqual(snapshot.customerEvidence, [
    {
      partId: "part_long",
      createdAt: 3,
      role: "customer",
      text: "x".repeat(1_200),
    },
  ])
  assert.equal(snapshot.evidenceTruncated, true)
  assert.equal(snapshot.partsTruncated, false)
  assert.deepEqual(snapshot.internalNoteDigests, [])
})

test("Intercom rejects missing required collections and over-bound part lists", async () => {
  const optionalFields = intercomConversation({
    conversation_parts: {
      type: "conversation_part.list",
      conversation_parts: [
        customerPart("long", 1, "x".repeat(1_201)),
        customerPart("bot", 2, "Automated public reply", {
          author: { type: "bot", id: "bot_1" },
        }),
        customerPart("team", 3, "Team public reply", {
          author: { type: "team", id: "team_1" },
        }),
      ],
      total_count: 3,
    },
  })
  delete optionalFields.company
  delete optionalFields.open
  delete optionalFields.priority
  const optionalSnapshot = await intercomClient(() =>
    jsonResponse(optionalFields)
  ).getConversation("conversation_123")
  assert.equal(optionalSnapshot.companyId, null)
  assert.equal(optionalSnapshot.priority, false)
  assert.equal(optionalSnapshot.evidenceTruncated, true)
  assert.deepEqual(
    optionalSnapshot.customerEvidence.map(({ partId, role }) => ({
      partId,
      role,
    })),
    [
      { partId: "team", role: "support" },
      { partId: "bot", role: "support" },
      { partId: "long", role: "customer" },
    ]
  )

  const missingTags = intercomConversation()
  delete missingTags.tags
  await assert.rejects(
    intercomClient(() => jsonResponse(missingTags)).getConversation(
      "conversation_123"
    ),
    (error: unknown) =>
      error instanceof EscalationError &&
      error.code === "INVALID_PROVIDER_RESPONSE"
  )

  const tooManyParts = intercomConversation({
    conversation_parts: {
      type: "conversation_part.list",
      conversation_parts: Array.from({ length: 501 }, (_, index) =>
        customerPart(`part_${index}`, index, "text")
      ),
      total_count: 501,
    },
  })
  await assert.rejects(
    intercomClient(() => jsonResponse(tooManyParts)).getConversation(
      "conversation_123"
    ),
    (error: unknown) =>
      error instanceof EscalationError &&
      error.code === "INVALID_PROVIDER_RESPONSE"
  )
})

test("Intercom mutations use the exact v2.15 endpoints and request bodies", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const responses = [
    { type: "tag", id: "tag_escalated" },
    {
      type: "conversation",
      id: "123",
      team_assignee_id: "team_escalations",
    },
    { type: "conversation", id: "123" },
  ]
  const client = intercomClient((url, init) => {
    calls.push({ url, init })
    const response = responses.shift()
    assert.ok(response)
    return jsonResponse(response)
  })

  await client.addTag("conversation_123", "tag_escalated")
  await client.routeToTeam("conversation_123", "team_escalations")
  await client.addInternalNote(
    "conversation_123",
    "Notion ticket: https://notion.so/ticket"
  )

  assert.equal(calls.length, 3)
  assert.deepEqual(
    calls.map(({ url, init }) => ({
      url,
      method: init.method,
      body: JSON.parse(String(init.body)) as unknown,
    })),
    [
      {
        url: "https://api.intercom.io/conversations/123/tags",
        method: "POST",
        body: { id: "tag_escalated", admin_id: "admin_1" },
      },
      {
        url: "https://api.intercom.io/conversations/123/parts",
        method: "POST",
        body: {
          message_type: "assignment",
          type: "team",
          admin_id: "admin_1",
          assignee_id: "team_escalations",
        },
      },
      {
        url: "https://api.intercom.io/conversations/123/reply",
        method: "POST",
        body: {
          message_type: "note",
          type: "admin",
          admin_id: "admin_1",
          body: "Notion ticket: https://notion.so/ticket",
        },
      },
    ]
  )
  for (const { init } of calls) {
    const headers = new Headers(init.headers)
    assert.equal(headers.get("intercom-version"), "2.15")
    assert.equal(headers.get("content-type"), "application/json")
  }
})

test("Intercom read transport retries 408 and oversized 500 responses", async () => {
  for (const scenario of ["timeout", "oversized"] as const) {
    let calls = 0
    let sleeps = 0
    const fetchFn: FetchLike = async () => {
      calls += 1
      return scenario === "timeout"
        ? new Response("timed out", { status: 408 })
        : new Response(`secret-${"x".repeat(200)}`, { status: 500 })
    }
    await assert.rejects(
      requestIntercomJson(
        "https://api.intercom.io/test",
        {},
        {
          fetchFn,
          timeoutMs: 1_000,
          sleep: async () => {
            sleeps += 1
          },
          maximumBytes: 32,
          mutation: false,
          expectedStatuses: [200],
        }
      ),
      (error: unknown) => {
        assert.ok(error instanceof IntercomApiError)
        assert.equal(error.retryable, true)
        assert.doesNotMatch(error.message, /secret-/)
        return true
      }
    )
    assert.equal(calls, 3)
    assert.equal(sleeps, 2)
  }
})
