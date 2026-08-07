import assert from "node:assert/strict"
import test from "node:test"

import {
  getPageSnapshot,
  NotionPageError,
  type NotionClientLike,
} from "../src/notion.js"

const PAGE_ID = "11111111-2222-3333-4444-555555555555"
const COMPACT_PAGE_ID = PAGE_ID.replaceAll("-", "")
const LAST_EDITED = "2026-07-05T12:00:00.000Z"

function notionReturning(response: unknown): NotionClientLike {
  return {
    pages: {
      retrieve: async () => response,
    },
  }
}

test("retrieves only the source page and returns its current edit metadata", async () => {
  const calls: unknown[] = []
  const notion: NotionClientLike = {
    pages: {
      retrieve: async (args) => {
        calls.push(args)
        return {
          id: PAGE_ID,
          url: `https://www.notion.so/${COMPACT_PAGE_ID}`,
          last_edited_time: LAST_EDITED,
          archived: false,
          in_trash: false,
        }
      },
    },
  }

  assert.deepEqual(await getPageSnapshot(notion, PAGE_ID), {
    pageId: COMPACT_PAGE_ID,
    url: `https://www.notion.so/${COMPACT_PAGE_ID}`,
    lastEditedTime: LAST_EDITED,
  })
  assert.deepEqual(calls, [{ page_id: COMPACT_PAGE_ID }])
  assert.equal("update" in notion.pages, false)
})

test("uses a canonical Notion URL when the provider URL is absent or unsafe", async () => {
  const snapshot = await getPageSnapshot(
    notionReturning({
      id: COMPACT_PAGE_ID,
      url: "https://attacker.example/page",
      last_edited_time: LAST_EDITED,
    }),
    PAGE_ID
  )

  assert.equal(snapshot.url, `https://www.notion.so/${COMPACT_PAGE_ID}`)
})

test("rejects stale, mismatched, archived, and trashed page metadata", async () => {
  const invalidPages = [
    { id: COMPACT_PAGE_ID },
    {
      id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      last_edited_time: LAST_EDITED,
    },
    {
      id: COMPACT_PAGE_ID,
      last_edited_time: "not-a-date",
    },
    {
      id: COMPACT_PAGE_ID,
      last_edited_time: LAST_EDITED,
      archived: true,
    },
    {
      id: COMPACT_PAGE_ID,
      last_edited_time: LAST_EDITED,
      in_trash: true,
    },
  ]

  for (const page of invalidPages) {
    await assert.rejects(
      getPageSnapshot(notionReturning(page), PAGE_ID),
      (error: unknown) =>
        error instanceof NotionPageError &&
        error.kind === "conflict" &&
        !error.retryable
    )
  }
})

test("classifies provider errors without exposing their bodies", async () => {
  const failing = (status: number, secret: string): NotionClientLike => ({
    pages: {
      retrieve: async () => {
        throw { status, body: secret }
      },
    },
  })

  await assert.rejects(
    getPageSnapshot(failing(404, "private-provider-message"), PAGE_ID),
    (error: unknown) => {
      assert(error instanceof NotionPageError)
      assert.equal(error.kind, "conflict")
      assert.equal(error.retryable, false)
      assert.doesNotMatch(error.message, /private-provider-message/)
      return true
    }
  )
  await assert.rejects(
    getPageSnapshot(failing(429, "rate-limit-details"), PAGE_ID),
    (error: unknown) =>
      error instanceof NotionPageError &&
      error.kind === "unavailable" &&
      error.retryable
  )
})

test("treats an invalid page id as a conflict before calling Notion", async () => {
  let called = false
  const notion: NotionClientLike = {
    pages: {
      retrieve: async () => {
        called = true
        return null
      },
    },
  }

  await assert.rejects(
    getPageSnapshot(notion, "not-a-page"),
    (error: unknown) =>
      error instanceof NotionPageError && error.kind === "conflict"
  )
  assert.equal(called, false)
})

test("bounds a stalled Notion read with a retryable unavailable error", async () => {
  const notion: NotionClientLike = {
    pages: {
      retrieve: async () => new Promise<never>(() => undefined),
    },
  }

  await assert.rejects(
    getPageSnapshot(notion, PAGE_ID, 1),
    (error: unknown) =>
      error instanceof NotionPageError &&
      error.kind === "unavailable" &&
      error.retryable
  )
})
