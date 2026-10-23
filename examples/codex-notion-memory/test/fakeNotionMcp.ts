import assert from "node:assert/strict"

interface FakePage {
  id: string
  Title: string
  Type?: string
  content: string
  deleted?: boolean
}

// In-memory stand-in for the Notion MCP tools the sync calls.
export function fakeNotionMcp(existing: Partial<FakePage>[] = []) {
  const DATA_SOURCE = "collection://00000000-0000-0000-0000-000000000001"
  const pages = new Map<string, FakePage>()
  const calls: string[] = []
  const add = (page: Partial<FakePage>) => {
    const id = `page-${pages.size + 1}`
    pages.set(id, {
      id,
      Title: "",
      content: "",
      ...page,
    })
    return id
  }
  existing.forEach(add)

  async function callTool(tool: string, args: any): Promise<unknown> {
    calls.push(tool)
    switch (tool) {
      case "notion-get-self":
        return { user: { name: "Casey Boyer" } }
      case "notion-fetch": {
        if (args.id === "memory")
          return { text: `<data-source url="${DATA_SOURCE}">` }
        const page = pages.get(args.id)
        assert.ok(page, `unknown page ${args.id}`)
        const properties = JSON.stringify({
          Title: page.Title,
          Type: page.Type,
        })
        return {
          text: `<page url="https://notion.so/${page.id}"${page.deleted ? " deleted" : ""}>\n<properties>\n${properties}\n</properties>\n<content>\n${page.content}\n</content>\n</page>`,
        }
      }
      case "notion-query-data-sources":
        assert.deepEqual(args.data.data_source_urls, [DATA_SOURCE])
        return { results: [...pages.values()] }
      case "notion-create-pages": {
        assert.equal(args.parent, "memory")
        const [page] = args.pages
        assert.equal(page.properties.Source, undefined)
        return {
          pages: [
            {
              id: add({
                Title: page.properties.title,
                Type: page.properties.Type,
                content: page.content,
              }),
            },
          ],
        }
      }
      case "notion-update-page": {
        const page = pages.get(args.page_id)
        assert.ok(page, `unknown page ${args.page_id}`)
        assert.equal(args.command, "replace_content")
        page.content = args.new_str
        return {}
      }
      case "notion-finish-revision":
        return {}
      default:
        throw new Error(`unexpected tool ${tool}`)
    }
  }
  return { pages, calls, callTool }
}
