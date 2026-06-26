import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"
import type { TopLevelSpec } from "vega-lite"

import { clampScaleFactor, renderVegaLiteToPng } from "./chart.js"
import { extractId } from "./notion.js"

const worker = new Worker()
export default worker

// generateChart renders a chart and uploads it; insertImage embeds the upload
// on a page. Splitting them lets an agent reuse one upload in several places.

worker.tool("generateChart", {
  title: "Generate Chart",
  description:
    "Render a Vega-Lite spec to a PNG and upload it to Notion. Returns a fileUploadId you can embed with the insertImage tool.",
  schema: j.object({
    spec: j
      .string()
      .describe(
        "Vega-Lite v6 specification as a JSON string. Include $schema, data, mark, and encoding at minimum."
      ),
    scaleFactor: j
      .number()
      .nullable()
      .describe(
        "PNG scale factor for resolution. Default 2 (retina); clamped to 1–5."
      ),
  }),
  execute: async ({ spec, scaleFactor }, { notion }) => {
    let parsed: TopLevelSpec
    try {
      parsed = JSON.parse(spec) as TopLevelSpec
    } catch {
      throw new Error(
        "Invalid spec: must be a JSON string containing a Vega-Lite specification."
      )
    }

    let png: Buffer
    try {
      png = await renderVegaLiteToPng(parsed, clampScaleFactor(scaleFactor))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to render the Vega-Lite spec: ${detail}`)
    }
    const filename = `chart-${Date.now()}.png`

    const upload = await notion.fileUploads.create({
      filename,
      content_type: "image/png",
    })
    await notion.fileUploads.send({
      file_upload_id: upload.id,
      file: {
        data: new Blob([new Uint8Array(png)], { type: "image/png" }),
        filename,
      },
    })

    return { fileUploadId: upload.id, filename, sizeBytes: png.byteLength }
  },
})

worker.tool("insertImage", {
  title: "Insert Image",
  description:
    "Append an uploaded image as a child of a Notion page or block. Use afterBlockId to place it after a specific sibling, or omit to append at the end.",
  schema: j.object({
    fileUploadId: j
      .string()
      .describe("The fileUploadId returned by generateChart."),
    parent: j
      .string()
      .describe(
        "Page or block to append the image into. Accepts a Notion URL or a UUID."
      ),
    afterBlockId: j
      .string()
      .nullable()
      .describe(
        "Insert the image after this child block (URL or UUID). Null to append at the end."
      ),
  }),
  execute: async ({ fileUploadId, parent, afterBlockId }, { notion }) => {
    const blockId = extractId(parent)
    await notion.blocks.children.append({
      block_id: blockId,
      children: [
        {
          type: "image",
          image: {
            type: "file_upload",
            file_upload: { id: extractId(fileUploadId) },
          },
        },
      ],
      ...(afterBlockId ? { after: extractId(afterBlockId) } : {}),
    })
    return { parentId: blockId }
  },
})
