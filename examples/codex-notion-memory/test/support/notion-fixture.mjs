import assert from "node:assert/strict"
import fs from "node:fs"

export const toolNames = [
  "get-self",
  "fetch",
  "query-data-sources",
  "create-pages",
  "update-page",
  "move-pages",
  "finish-revision",
]
const collection = "collection://00000000-0000-0000-0000-000000000001"
const stateFile = process.env.FIXTURE_STATE
const callsFile = process.env.FIXTURE_CALLS
assert.ok(stateFile && callsFile, "fixture paths must be explicitly supplied")

export function record(method) {
  fs.appendFileSync(callsFile, JSON.stringify({ method }) + "\n")
}

export function invoke(name, args) {
  const tool = name.replace(/^notion-/, "")
  record(tool)
  if (process.env.FIXTURE_FAILURE === "unauthorized")
    throw new Error("Notion fixture: unauthorized")
  const state = fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, "utf8"))
    : { pages: [] }
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state))
  switch (tool) {
    case "get-self":
      return { user: { name: "Casey Synthetic" } }
    case "fetch": {
      if (args.id === "memory")
        return { text: `<data-source url="${collection}">` }
      const page = state.pages.find((p) => p.id === args.id)
      assert.ok(page, "unknown fixture page")
      return {
        text: `<page${page.deleted ? " deleted" : ""}>${page.parent !== "memory" && page.parent !== "private" ? `<parent-page url="https://notion.so/${page.parent}"/>` : ""}<properties>${JSON.stringify({ Title: page.title, Type: page.type })}</properties><content>${page.content}</content></page>`,
      }
    }
    case "query-data-sources": {
      const offset = Number(args.data.query.match(/OFFSET (\d+)/)?.[1] ?? 0)
      const limit = Number(args.data.query.match(/LIMIT (\d+)/)?.[1] ?? 200)
      return {
        results: state.pages
          .filter((p) => p.parent === "memory" && !p.deleted)
          .slice(offset, offset + limit)
          .map((p) => ({ Title: p.title })),
      }
    }
    case "create-pages": {
      assert.ok(
        args.parent === "memory" ||
          args.parent?.page_id ||
          args.creation_mode === "draft"
      )
      const pages = args.pages.map((p) => {
        assert.equal(p.properties.Source, undefined)
        const page = {
          id: `synthetic-${state.pages.length + 1}`,
          title: p.properties.title,
          type: p.properties.Type,
          content: p.content,
          parent:
            args.parent === "memory"
              ? "memory"
              : (args.parent?.page_id ?? "private"),
        }
        state.pages.push(page)
        return { id: page.id, url: `https://notion.so/${page.id}` }
      })
      save()
      return { pages }
    }
    case "update-page": {
      const page = state.pages.find((p) => p.id === args.page_id)
      assert.ok(page, "unknown fixture page")
      assert.equal(args.command, "replace_content")
      page.content = args.new_str
      save()
      return {}
    }
    case "move-pages": {
      if (process.env.FIXTURE_FAILURE === "move-denied")
        throw new Error("fixture move forbidden")
      for (const id of args.page_or_database_ids) {
        const page = state.pages.find((p) => p.id === id)
        assert.ok(page)
        page.parent = args.new_parent.page_id
        delete page.type
      }
      save()
      if (process.env.FIXTURE_FAILURE === "move-interrupted")
        throw new Error("fixture interrupted after move")
      return {}
    }
    case "finish-revision":
      return {}
    default:
      throw new Error(`unexpected fixture tool: ${tool}`)
  }
}

export function toolResult(name, args) {
  try {
    return {
      content: [
        { type: "text", text: JSON.stringify(invoke(name, args)) },
        ...(process.env.FIXTURE_NOTICE
          ? [{ type: "text", text: "Synthetic workspace quota notice" }]
          : []),
      ],
    }
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error.message }] }
  }
}
