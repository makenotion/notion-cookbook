import assert from "node:assert/strict"
import test from "node:test"
import { Client } from "@notionhq/client"
import { upsertZendeskTicket } from "./src/notion.js"
import type { ZendeskTicket } from "./src/zendesk/types.js"

const databaseId = "550e8400e29b41d4a716446655440000"
const ticket: ZendeskTicket = {
  ticketId: "42",
  ticketUrl: "https://acme.zendesk.com/agent/tickets/42",
  email: "requester@example.com",
  subject: "A ticket",
  description: "Ticket description",
  assignee: "An agent",
  status: "Open",
  latestComment: "Latest comment",
  createdAt: "2026-01-01T00:00:00.000Z",
}

test("creates a ticket in the database's data source", async () => {
  const { notion, requests } = makeNotionClient(["source-id"], undefined)

  const result = await upsertZendeskTicket(notion, databaseId, ticket)

  assert.deepEqual(result, { action: "created", pageId: "created-page" })
  const query = requests.find((request) => request.path.endsWith("/query"))
  assert.ok(query)
  assert.equal(query.path, "/v1/data_sources/source-id/query")
  assert.partialDeepStrictEqual(query.body, {
    filter: { property: "Zendesk Ticket ID", title: { equals: "42" } },
  })
  const create = requests.find((request) => request.path === "/v1/pages")
  assert.ok(create)
  assert.partialDeepStrictEqual(create.body, {
    parent: { data_source_id: "source-id" },
    properties: { Subject: { rich_text: [{ text: { content: "A ticket" } }] } },
  })
  const append = requests.find((request) => request.method === "PATCH")
  assert.ok(append)
  assert.equal(append.path, "/v1/blocks/created-page/children")
  assert.partialDeepStrictEqual(append.body, {
    children: [
      {
        paragraph: { rich_text: [{ text: { content: "Ticket description" } }] },
      },
    ],
  })
})

test("updates the matching ticket instead of creating a duplicate", async () => {
  const { notion, requests } = makeNotionClient(["source-id"], "existing-page")

  const result = await upsertZendeskTicket(notion, databaseId, ticket)

  assert.deepEqual(result, { action: "updated", pageId: "existing-page" })
  const update = requests.find(
    (request) => request.path === "/v1/pages/existing-page"
  )
  assert.ok(update)
  assert.equal(update.method, "PATCH")
  assert.partialDeepStrictEqual(update.body, {
    properties: { Status: { status: { name: "Open" } } },
  })
  assert.equal(
    requests.some((request) => request.path === "/v1/pages"),
    false
  )
})

for (const dataSourceIds of [[], ["first-source", "second-source"]]) {
  test(`rejects a database with ${dataSourceIds.length} data sources before writing`, async () => {
    const { notion, requests } = makeNotionClient(dataSourceIds, undefined)

    await assert.rejects(
      upsertZendeskTicket(notion, databaseId, ticket),
      /exactly one data source/
    )

    assert.deepEqual(
      requests.map(({ method }) => method),
      ["GET"]
    )
  })
}

function makeNotionClient(
  dataSourceIds: string[],
  existingPageId: string | undefined
) {
  const requests: Array<{ method: string; path: string; body: unknown }> = []
  const notion = new Client({
    auth: "offline-test-token",
    retry: false,
    fetch: async (url, init) => {
      const path = new URL(url).pathname
      const method = init?.method ?? "GET"
      const body: unknown =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      requests.push({ path, method, body })
      if (path === `/v1/databases/${databaseId}`) {
        return Response.json({
          object: "database",
          id: databaseId,
          title: [],
          data_sources: dataSourceIds.map((id) => ({ id, name: "Tickets" })),
        })
      }
      if (path === "/v1/data_sources/source-id/query") {
        return Response.json({
          results: existingPageId
            ? [{ object: "page", id: existingPageId }]
            : [],
          has_more: false,
          next_cursor: null,
        })
      }
      if (path === "/v1/pages") return Response.json({ id: "created-page" })
      if (path === "/v1/pages/existing-page")
        return Response.json({ id: "existing-page" })
      if (path.endsWith("/children")) {
        return Response.json({
          results: [],
          has_more: false,
          next_cursor: null,
        })
      }
      throw new Error(`Unexpected offline request: ${method} ${path}`)
    },
  })
  return { notion, requests }
}
