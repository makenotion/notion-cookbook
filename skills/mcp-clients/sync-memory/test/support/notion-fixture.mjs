import assert from "node:assert/strict"
import fs from "node:fs"

export const toolNames = ["get-self", "fetch", "create-pages", "update-page"]
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
  const importedContent = (content) =>
    process.env.FIXTURE_NORMALIZE_MARKDOWN
      ? content.replace(/\r\n/g, "\n")
      : content
  const failOnce = (phase) => {
    if (process.env.FIXTURE_FAIL_ONCE !== phase || state.failedOnce === phase)
      return
    state.failedOnce = phase
    save()
    throw new Error(`Synthetic ${phase} failure`)
  }
  switch (tool) {
    case "get-self":
      return {
        user: { name: "Casey Synthetic" },
        workspace: { id: "synthetic-workspace" },
      }
    case "fetch": {
      if (args.id === "memory")
        return { text: `<data-source url="${collection}">` }
      failOnce("fetch")
      if (state.failReadback) failOnce(state.failReadback)
      const page = state.pages.find((p) => p.id === args.id)
      assert.ok(page, "unknown fixture page")
      if (process.env.FIXTURE_READBACK === "malformed")
        return { text: "<page><content>broken</content></page>" }
      return {
        text: `<page${page.deleted ? " deleted" : ""}>${page.parent !== "memory" && page.parent !== "private" ? `<parent-page url="https://notion.so/${page.parent}"/>` : ""}<properties>${JSON.stringify({ Title: page.title, Type: page.type, Source: page.source, "Last updated by": page.lastUpdatedBy })}</properties><content>${page.content}</content></page>`,
      }
    }
    case "create-pages": {
      assert.ok(
        args.parent === "memory" ||
          args.parent?.page_id ||
          args.creation_mode === "draft"
      )
      const pages = args.pages.map((p) => {
        assert.equal(
          p.properties.Source,
          args.parent === "memory" ? "Codex" : undefined
        )
        const page = {
          id: `synthetic-${state.pages.length + 1}`,
          title: p.properties.title,
          type: p.properties.Type,
          source: p.properties.Source,
          lastUpdatedBy: p.properties["Last updated by"],
          content: importedContent(p.content),
          parent:
            args.parent === "memory"
              ? "memory"
              : (args.parent?.page_id ?? "private"),
        }
        state.pages.push(page)
        return { id: page.id, url: `https://notion.so/${page.id}` }
      })
      save()
      failOnce("create-response")
      return { pages }
    }
    case "update-page": {
      const page = state.pages.find((p) => p.id === args.page_id)
      assert.ok(page, "unknown fixture page")
      if (args.command === "update_properties") {
        if (args.properties.Source !== undefined)
          page.source = args.properties.Source
        if (args.properties["Last updated by"] !== undefined)
          page.lastUpdatedBy = args.properties["Last updated by"]
        save()
        return {}
      }
      assert.equal(args.command, "replace_content")
      page.content = importedContent(args.new_str)
      if (process.env.FIXTURE_FAIL_ONCE?.startsWith("update-readback"))
        state.failReadback = process.env.FIXTURE_FAIL_ONCE
      save()
      failOnce("update-response")
      return {}
    }
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
