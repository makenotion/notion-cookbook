import { Worker } from "@notionhq/workers"

const worker = new Worker()
export default worker

worker.customBlock("whiteboard", {
  path: "./blocks/whiteboard",
  command: "npx vite build",
  output: "dist",
  version: 1,
  dataSources: {
    items: {
      name: "Whiteboard items",
      description:
        "Every object on the whiteboard canvas — sticky notes, freehand strokes, lines, and arrows — one row each.",
      icon: { type: "emoji", emoji: "🖊️" },
      properties: {
        title: {
          name: "Title",
          description:
            'Sticky note text, or an auto label for drawn objects ("Stroke", "Line", "Arrow").',
          type: "title",
        },
        type: {
          name: "Type",
          description: "Kind of canvas object: sticky, stroke, line, or arrow.",
          type: "select",
        },
        color: {
          name: "Color",
          description:
            "Named NDS color: yellow, blue, pink, green, purple, red, or gray.",
          type: "select",
        },
        x: {
          name: "X",
          description:
            "Canvas x position (top-left for stickies, bounding origin for strokes).",
          type: "number",
        },
        y: {
          name: "Y",
          description:
            "Canvas y position (top-left for stickies, bounding origin for strokes).",
          type: "number",
        },
        width: {
          name: "Width",
          description: "Sticky size / bounding box width.",
          type: "number",
        },
        height: {
          name: "Height",
          description: "Sticky size / bounding box height.",
          type: "number",
        },
        points: {
          name: "Points",
          description:
            "JSON-encoded point array for strokes, lines, and arrows, relative to (x, y).",
          type: "rich_text",
        },
        strokeWidth: {
          name: "Stroke width",
          description: "Ink stroke width in pixels.",
          type: "number",
        },
        z: {
          name: "Z",
          description: "Stacking order — higher renders on top.",
          type: "number",
        },
      },
    },
  },
})
