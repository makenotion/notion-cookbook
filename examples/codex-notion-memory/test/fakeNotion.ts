import assert from "node:assert/strict"
import type { NotionClient } from "../plugin/src/notion.ts"

// In-memory stand-in for the Notion API calls the memory sync makes.
export function fakeNotion(source: string) {
  const pages = new Map<
    string,
    { last_edited_time: string; in_trash: boolean; title: string }
  >()
  let next = 0
  const client = {
    async request(method: string, url: string, body: any) {
      assert.equal(`${method} ${url}`, "POST /v1/tools/run")
      assert.equal(body.create_pages.parent, "memory")
      const page = body.create_pages.pages[0]
      assert.equal(page.properties.Source, source)
      const id = `page-${++next}`
      pages.set(id, {
        last_edited_time: "t0",
        in_trash: false,
        title: page.properties.title,
      })
      return { pages: [{ id }] }
    },
    async getPage(id: string) {
      return { id, ...pages.get(id) }
    },
    async trashPage(id: string) {
      const page = pages.get(id)
      if (page) page.in_trash = true
      return { id }
    },
  }
  return { pages, client: client as unknown as NotionClient }
}
