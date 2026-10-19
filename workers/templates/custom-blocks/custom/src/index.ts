import { Worker } from "@notionhq/workers"

const worker = new Worker()
export default worker

worker.customBlock("helloWorld", {
  path: "./blocks/hello-world",
  command: "npx vite build",
  output: "dist",
  name: "Hello world",
  description: 'A minimal custom block that renders "Hello world".',
  icon: { type: "emoji", emoji: "👋" },
  slashCommand: "hello-world",
  version: 1,
  dataSources: {},
})
