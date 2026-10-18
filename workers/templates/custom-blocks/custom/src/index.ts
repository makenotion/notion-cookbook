import { Worker } from "@notionhq/workers"

const worker = new Worker()
export default worker

worker.customBlock("custom", {
  path: "./blocks/custom",
  command: "npx vite build",
  output: "dist",
  name: "Hello world",
  description:
    "A minimal custom block that renders Hello world inside a Notion page.",
  icon: { type: "emoji", emoji: "👋" },
  slashCommand: "hello-world",
  version: 1,
  dataSources: {},
})
