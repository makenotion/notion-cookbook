import assert from "node:assert/strict"
import test from "node:test"
import { boundedText, requestJson, type FetchLike } from "../src/http.js"
import { IntercomClient } from "../src/intercom.js"
import { JiraClient } from "../src/jira.js"
import { ProviderError, SafetyError } from "../src/types.js"
import { config, packet, setup } from "./helpers.js"

function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

test("read requests retry bounded 429 and honor Retry-After", async () => {
  let calls = 0
  const sleeps: number[] = []
  const value = await requestJson<{ ok: true }>(
    "Jira",
    "https://example.atlassian.net/rest/api/3/myself",
    { method: "GET" },
    {
      timeoutMs: 1000,
      mutation: false,
      expectedStatuses: [200],
      fetchFn: async () => {
        calls += 1
        return calls === 1
          ? json({ error: "secret" }, 429, { "retry-after": "2" })
          : json({ ok: true })
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
      },
    }
  )
  assert.deepEqual(value, { ok: true })
  assert.equal(calls, 2)
  assert.deepEqual(sleeps, [2000])
})

test("non-idempotent mutation never retries and redacts provider body", async () => {
  let calls = 0
  await assert.rejects(
    requestJson(
      "Intercom",
      "https://api.intercom.io/conversations/123/reply",
      { method: "POST" },
      {
        timeoutMs: 1000,
        mutation: true,
        expectedStatuses: [200],
        fetchFn: async () => {
          calls += 1
          return json({ token: "do-not-expose" }, 503)
        },
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.equal(error.ambiguous, true)
      assert.doesNotMatch(error.message, /do-not-expose|token/)
      return true
    }
  )
  assert.equal(calls, 1)
})

test("definite mutation 429 returns bounded retry timing without retry", async () => {
  let calls = 0
  await assert.rejects(
    requestJson(
      "Jira",
      "https://example.atlassian.net/rest/api/3/issue",
      { method: "POST" },
      {
        timeoutMs: 1000,
        mutation: true,
        expectedStatuses: [201],
        fetchFn: async () => {
          calls += 1
          return json({}, 429, { "retry-after": "9999" })
        },
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.equal(error.retryAfterMs, 300000)
      assert.equal(error.ambiguous, false)
      return true
    }
  )
  assert.equal(calls, 1)
})

test("400, 401, 403, 404, 409, and 422 mutations are definite rejections", async () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    let calls = 0
    await assert.rejects(
      requestJson(
        "Jira",
        "https://example.atlassian.net/rest/api/3/issue",
        { method: "POST" },
        {
          timeoutMs: 1000,
          mutation: true,
          expectedStatuses: [201],
          fetchFn: async () => {
            calls += 1
            return json({ secret: "redacted" }, status)
          },
        }
      ),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        assert.equal(error.httpStatus, status)
        assert.equal(error.ambiguous, false)
        assert.doesNotMatch(error.message, /secret|redacted/)
        return true
      }
    )
    assert.equal(calls, 1)
  }
})

test("transport timeout before any mutation exhausts three bounded read attempts", async () => {
  let calls = 0
  await assert.rejects(
    requestJson(
      "Intercom",
      "https://api.intercom.io/me",
      { method: "GET" },
      {
        timeoutMs: 1000,
        mutation: false,
        expectedStatuses: [200],
        fetchFn: async () => {
          calls += 1
          throw new Error("network secret")
        },
        sleep: async () => undefined,
      }
    ),
    /could not be reached/
  )
  assert.equal(calls, 3)
})

test("bounded response reader aborts oversized provider content", async () => {
  await assert.rejects(
    boundedText(new Response("x".repeat(101)), 100),
    /fixed byte limit/
  )
})

test("mutation 2xx malformed, oversized, and stalled bodies are outcome-unknown", async () => {
  const cases: { name: string; fetchFn: FetchLike; timeoutMs: number }[] = [
    {
      name: "malformed",
      fetchFn: async () =>
        new Response("{", {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      timeoutMs: 100,
    },
    {
      name: "oversized",
      fetchFn: async () =>
        new Response(JSON.stringify({ value: "x".repeat(200) }), {
          status: 201,
        }),
      timeoutMs: 100,
    },
    {
      name: "stalled",
      fetchFn: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"))
            },
          }),
          { status: 201 }
        ),
      timeoutMs: 10,
    },
    {
      name: "truncated",
      fetchFn: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("truncated transport"))
            },
          }),
          { status: 201 }
        ),
      timeoutMs: 100,
    },
  ]
  for (const fixture of cases) {
    let calls = 0
    await assert.rejects(
      requestJson(
        "Jira",
        "https://example.atlassian.net/rest/api/3/issue",
        { method: "POST" },
        {
          timeoutMs: fixture.timeoutMs,
          maximumBytes: fixture.name === "oversized" ? 20 : 1_000,
          mutation: true,
          expectedStatuses: [201],
          fetchFn: async (url, init) => {
            calls += 1
            return fixture.fetchFn(url, init)
          },
        }
      ),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError, fixture.name)
        assert.equal(error.ambiguous, true, fixture.name)
        assert.equal(error.code, "MUTATION_OUTCOME_UNKNOWN", fixture.name)
        return true
      }
    )
    assert.equal(calls, 1, fixture.name)
  }
})

test("Intercom note payload is statically internal-only", async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const client = new IntercomClient(config(), {
    fetchFn: async (url, init) => {
      calls.push({ url: String(url), init })
      return json({ type: "conversation", id: "conv_123" })
    },
  })
  await client.addInternalNote("conversation", "conv_123", "[marker] Jira link")
  assert.equal(calls.length, 1)
  assert.equal(
    calls[0].url,
    "https://api.intercom.io/conversations/conv_123/reply"
  )
  const body = JSON.parse(String(calls[0].init?.body))
  assert.deepEqual(body, {
    message_type: "note",
    type: "admin",
    admin_id: "admin_123",
    body: "[marker] Jira link",
  })
  assert.equal(body.message_type, "note")
  assert.notEqual(body.message_type, "comment")
})

test("provider client response-shape failures after writes are explicitly ambiguous", async () => {
  const intercom = new IntercomClient(config(), {
    fetchFn: async () => json([]),
  })
  await assert.rejects(
    intercom.addInternalNote("conversation", "conv_123", "[marker] Jira"),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.equal(error.ambiguous, true)
      assert.equal(error.code, "MUTATION_OUTCOME_UNKNOWN")
      return true
    }
  )

  const fixture = setup()
  const jira = new JiraClient(config(), {
    fetchFn: async () => json({}, 201),
  })
  await assert.rejects(
    jira.createIssue({
      packet: packet(),
      source: fixture.intercom.source,
      contact: fixture.intercom.contact,
      company: fixture.intercom.company,
      marker: "notion-int-aaaaaaaaaaaaaaaaaaaaaaaa",
      propertyKey: "notion.intercom.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      safeAttachments: [],
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.equal(error.ambiguous, true)
      assert.equal(error.code, "MUTATION_OUTCOME_UNKNOWN")
      return true
    }
  )

  let propertyCalls = 0
  const propertyClient = new JiraClient(config(), {
    fetchFn: async () => {
      propertyCalls += 1
      return new Response("{", { status: 200 })
    },
  })
  await assert.rejects(
    propertyClient.putOperationMarker(
      "ENG-42",
      "notion.intercom.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "notion-int-aaaaaaaaaaaaaaaaaaaaaaaa"
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError)
      assert.equal(error.ambiguous, true)
      return true
    }
  )
  assert.equal(propertyCalls, 1)
})

test("Intercom conversation routing omits any customer-visible body", async () => {
  let body: Record<string, unknown> | null = null
  const client = new IntercomClient(config(), {
    fetchFn: async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return json({ id: "conv_123" })
    },
  })
  await client.routeToTeam("conversation", "conv_123", "team_engineering")
  assert.deepEqual(body, {
    message_type: "assignment",
    type: "team",
    admin_id: "admin_123",
    assignee_id: "team_engineering",
  })
})

test("numeric Conversation assignee IDs normalize to strings through route readback", async () => {
  let teamAssigneeId = 101
  let adminAssigneeId = 202
  const calls: { url: string; method: string; body: unknown }[] = []
  const conversation = (): Response =>
    json({
      id: "987654321",
      updated_at: 1_750_000_000,
      state: "open",
      source: { body: "Customer evidence" },
      contacts: { contacts: [{ id: "contact_123" }] },
      tags: { tags: [] },
      conversation_parts: {
        total_count: 0,
        conversation_parts: [],
      },
      team_assignee_id: teamAssigneeId,
      admin_assignee_id: adminAssigneeId,
    })
  const client = new IntercomClient(config(), {
    fetchFn: async (url, init) => {
      const method = init?.method ?? "GET"
      const body = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ url: String(url), method, body })
      if (method === "POST") {
        teamAssigneeId = Number((body as { assignee_id: string }).assignee_id)
        adminAssigneeId = 0
        return json({ id: "987654321" })
      }
      return conversation()
    },
  })
  const before = await client.getSource("conversation", "987654321")
  assert.equal(before.teamAssigneeId, "101")
  assert.equal(before.adminAssigneeId, "202")
  await client.routeToTeam("conversation", "987654321", "303")
  const after = await client.getSource("conversation", "987654321")
  assert.equal(after.teamAssigneeId, "303")
  assert.equal(after.adminAssigneeId, null)
  assert.deepEqual(calls[1], {
    url: "https://api.intercom.io/conversations/987654321/parts",
    method: "POST",
    body: {
      message_type: "assignment",
      type: "team",
      admin_id: "admin_123",
      assignee_id: "303",
    },
  })
})

test("Ticket assignee IDs remain string-only", async () => {
  const client = new IntercomClient(config(), {
    fetchFn: async () =>
      json({
        id: "ticket_123",
        updated_at: 1_750_000_000,
        ticket_state: { category: "submitted" },
        contacts: { contacts: [{ id: "contact_123" }] },
        tags: { tags: [] },
        ticket_parts: { total_count: 0, ticket_parts: [] },
        team_assignee_id: 101,
        admin_assignee_id: null,
      }),
  })
  await assert.rejects(
    client.getSource("ticket", "ticket_123"),
    /Ticket assignee IDs must remain strings/
  )
})

test("Intercom ticket HTTP paths parse ticket evidence and use ticket-only mutation payloads", async () => {
  const calls: { url: string; method: string; body: unknown }[] = []
  const responses = [
    json({
      id: "ticket_123",
      updated_at: 1_750_000_000,
      ticket_state: { category: "in_progress" },
      ticket_attributes: {
        _default_title_: "Checkout total",
        _default_description_: "Approved evidence",
      },
      contacts: { contacts: [{ id: "contact_123" }] },
      company: { id: "company_123" },
      team_assignee_id: "team_support",
      admin_assignee_id: "admin_123",
      tags: { tags: [{ id: "tag_existing", name: "customer" }] },
      ticket_parts: {
        total_count: 1,
        ticket_parts: [
          {
            id: "ticket_part_1",
            part_type: "note",
            body: "<p>Internal ticket evidence</p>",
            attachments: [],
          },
        ],
      },
    }),
    json({ id: "tag_escalated" }),
    json({ id: "ticket_123" }),
    json({ id: "ticket_part_2", part_type: "note" }),
  ]
  const client = new IntercomClient(config(), {
    fetchFn: async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      const response = responses.shift()
      assert.ok(response)
      return response
    },
  })
  const source = await client.getSource("ticket", "ticket_123")
  assert.equal(source.kind, "ticket")
  assert.equal(source.state, "in_progress")
  assert.equal(source.contactIds[0], "contact_123")
  assert.equal(source.parts[0].id, "ticket_part_1")
  await client.addTag("ticket", "ticket_123", "tag_escalated")
  await client.routeToTeam("ticket", "ticket_123", "team_engineering")
  await client.addInternalNote("ticket", "ticket_123", "[marker] Jira link")

  assert.deepEqual(calls, [
    {
      url: "https://api.intercom.io/tickets/ticket_123",
      method: "GET",
      body: null,
    },
    {
      url: "https://api.intercom.io/tickets/ticket_123/tags",
      method: "POST",
      body: { id: "tag_escalated", admin_id: "admin_123" },
    },
    {
      url: "https://api.intercom.io/tickets/ticket_123",
      method: "PUT",
      body: {
        skip_notifications: true,
        assignment: {
          admin_id: "admin_123",
          assignee_id: "team_engineering",
        },
      },
    },
    {
      url: "https://api.intercom.io/tickets/ticket_123/reply",
      method: "POST",
      body: {
        message_type: "note",
        type: "admin",
        admin_id: "admin_123",
        body: "[marker] Jira link",
      },
    },
  ])
})

test("Intercom contact-company pagination is bounded to three pages", async () => {
  let calls = 0
  const client = new IntercomClient(config(), {
    fetchFn: async () => {
      calls += 1
      return json({
        data: Array.from({ length: 50 }, (_, index) => ({
          id: `company_${calls}_${index}`,
        })),
        pages: { next: { starting_after: `cursor_${calls}` } },
      })
    },
  })
  await assert.rejects(
    client.listContactCompanyIds("contact_123"),
    /150-company verification bound/
  )
  assert.equal(calls, 3)
})

test("Jira create request carries fixed marker label/property and excludes raw Intercom text", async () => {
  const fixture = setup()
  let requestBody: Record<string, unknown> | null = null
  const client = new JiraClient(config(), {
    fetchFn: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return json({ id: "10042", key: "ENG-42" }, 201)
    },
  })
  await client.createIssue({
    packet: packet(),
    source: fixture.intercom.source,
    contact: fixture.intercom.contact,
    company: fixture.intercom.company,
    marker: "notion-int-aaaaaaaaaaaaaaaaaaaaaaaa",
    propertyKey: "notion.intercom.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    safeAttachments: [
      { name: "screen.png", contentType: "image/png", size: 1234 },
    ],
  })
  const encoded = JSON.stringify(requestBody)
  assert.match(encoded, /notion-int-aaaaaaaaaaaaaaaaaaaaaaaa/)
  assert.match(encoded, /notion\.intercom\.aaaaaaaa/)
  assert.match(encoded, /screen\.png/)
  assert.doesNotMatch(encoded, /ignore previous instructions/)
  assert.doesNotMatch(encoded, /unsafe\.exe/)
  assert.doesNotMatch(encoded, /https?:\/\/.*intercom/)
})

test("Jira comment marker scan is bounded to 500 comments", async () => {
  let calls = 0
  const fetchFn: FetchLike = async () => {
    calls += 1
    return json({
      startAt: (calls - 1) * 100,
      maxResults: 100,
      total: 600,
      comments: Array.from({ length: 100 }, (_, index) => ({
        id: String(index),
        body: { type: "doc", version: 1, content: [] },
      })),
    })
  }
  const client = new JiraClient(config(), { fetchFn })
  await assert.rejects(
    client.findCommentMarker("ENG-42", "notion-int-aaaaaaaaaaaaaaaaaaaaaaaa"),
    (error: unknown) => {
      assert.ok(error instanceof SafetyError)
      assert.equal(error.code, "COMMENT_LIMIT")
      return true
    }
  )
  assert.equal(calls, 5)
})
