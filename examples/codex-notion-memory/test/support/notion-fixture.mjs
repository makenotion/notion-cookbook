import assert from "node:assert/strict"
import fs from "node:fs"

export const toolNames = [
  "get-self",
  "fetch",
  "query-data-sources",
  "create-pages",
  "update-page",
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
        text: `<page${page.deleted ? " deleted" : ""}><properties>${JSON.stringify({ Title: page.title, Type: page.type })}</properties><content>${page.content}</content></page>`,
      }
    }
    case "query-data-sources":
      return { results: state.pages.map((p) => ({ Title: p.title })) }
    case "create-pages": {
      assert.equal(args.parent, "memory")
      const pages = args.pages.map((p) => {
        assert.equal(p.properties.Source, undefined)
        const page = {
          id: `synthetic-${state.pages.length + 1}`,
          title: p.properties.title,
          type: p.properties.Type,
          content: p.content,
        }
        state.pages.push(page)
        return { id: page.id }
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
    case "finish-revision":
      return {}
    default:
      throw new Error(`unexpected fixture tool: ${tool}`)
  }
}

export function toolResult(name, args) {
  try {
    return {
      content: [{ type: "text", text: JSON.stringify(invoke(name, args)) }],
    }
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error.message }] }
  }
}
