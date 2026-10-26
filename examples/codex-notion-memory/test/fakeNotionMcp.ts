import assert from "node:assert/strict"

interface FakePage {
  id: string
  Title: string
  Type?: string
  Source?: string
  lastUpdatedBy?: string
  content: string
  deleted?: boolean
}

// In-memory stand-in for the Notion MCP tools the sync calls. `source` is the agent the
// sync must attribute new memories to.
export function fakeNotionMcp(
  existing: Partial<FakePage>[] = [],
  source: "Codex" | "Claude Code" = "Codex"
) {
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
      case "get-self":
        return { user: { name: "Casey Boyer" } }
      case "fetch": {
        const page = pages.get(args.id)
        assert.ok(page, `unknown page ${args.id}`)
        const properties = JSON.stringify({
          Title: page.Title,
          Type: page.Type,
          Source: page.Source,
          "Last updated by": page.lastUpdatedBy,
        })
        return {
          text: `<page url="https://notion.so/${page.id}"${page.deleted ? " deleted" : ""}>\n<properties>\n${properties}\n</properties>\n<content>\n${page.content}\n</content>\n</page>`,
        }
      }
      case "create-pages": {
        assert.equal(args.parent, "memory")
        const [page] = args.pages
        assert.equal(page.properties.Source, source)
        return {
          pages: [
            {
              id: add({
                Title: page.properties.title,
                Type: page.properties.Type,
                Source: page.properties.Source,
                lastUpdatedBy: page.properties["Last updated by"],
                content: page.content,
              }),
            },
          ],
        }
      }
      case "update-page": {
        const page = pages.get(args.page_id)
        assert.ok(page, `unknown page ${args.page_id}`)
        if (args.command === "update_properties") {
          if (args.properties.Source !== undefined)
            page.Source = args.properties.Source
          page.lastUpdatedBy = args.properties["Last updated by"]
          return {}
        }
        assert.equal(args.command, "replace_content")
        page.content = args.new_str
        return {}
      }
      default:
        throw new Error(`unexpected tool ${tool}`)
    }
  }
  return { pages, calls, callTool }
}
