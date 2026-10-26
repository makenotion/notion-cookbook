import assert from "node:assert/strict"

interface FakePage {
  id: string
  Title: string
  Type?: string
  Source?: string
  lastUpdatedBy?: string
  content: string
  // "memory" for the Memories data source, "private" for a draft, or a parent page ID.
  parent: string
  deleted?: boolean
}

// In-memory stand-in for the Notion MCP tools the sync calls. `source` is the agent the
// sync must attribute new memories to.
export function fakeNotionMcp(
  existing: Partial<FakePage>[] = [],
  source: "Codex" | "Claude Code" = "Codex"
) {
  const DATA_SOURCE = "collection://00000000-0000-0000-0000-000000000001"
  const pages = new Map<string, FakePage>()
  const calls: string[] = []
  const add = (page: Partial<FakePage>) => {
    const id = `page-${pages.size + 1}`
    pages.set(id, {
      id,
      Title: "",
      content: "",
      parent: "memory",
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
        if (args.id === "memory")
          return { text: `<data-source url="${DATA_SOURCE}">` }
        const page = pages.get(args.id)
        assert.ok(page, `unknown page ${args.id}`)
        const properties = JSON.stringify({
          Title: page.Title,
          Type: page.Type,
          Source: page.Source,
          "Last updated by": page.lastUpdatedBy,
        })
        const parent =
          page.parent === "memory" || page.parent === "private"
            ? ""
            : `\n<parent-page url="https://notion.so/${page.parent}"/>`
        return {
          text: `<page url="https://notion.so/${page.id}"${page.deleted ? " deleted" : ""}>${parent}\n<properties>\n${properties}\n</properties>\n<content>\n${page.content}\n</content>\n</page>`,
        }
      }
      case "query-data-sources":
        assert.deepEqual(args.data.data_source_urls, [DATA_SOURCE])
        return {
          results: [...pages.values()].filter((p) => p.parent === "memory"),
        }
      case "create-pages": {
        // Memories go to the Memories data source; the archive root is a private draft.
        assert.ok(
          args.parent === "memory" || args.creation_mode === "draft",
          "page created outside Memories without draft mode"
        )
        const [page] = args.pages
        assert.equal(
          page.properties.Source,
          args.parent === "memory" ? source : undefined
        )
        return {
          pages: [
            {
              id: add({
                Title: page.properties.title,
                Type: page.properties.Type,
                Source: page.properties.Source,
                lastUpdatedBy: page.properties["Last updated by"],
                content: page.content,
                parent: args.parent === "memory" ? "memory" : "private",
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
      case "move-pages": {
        for (const id of args.page_or_database_ids) {
          const page = pages.get(id)
          assert.ok(page, `unknown page ${id}`)
          page.parent = args.new_parent.page_id
        }
        return {}
      }
      case "finish-revision":
        return {}
      default:
        throw new Error(`unexpected tool ${tool}`)
    }
  }
  return { pages, calls, callTool }
}
