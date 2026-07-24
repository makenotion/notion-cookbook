import { Worker } from "@notionhq/workers"

const worker = new Worker()
export default worker

worker.customBlock("custom", {
  path: "./blocks/custom",
  command: "npx vite build",
  output: "dist",
  version: 1,
  dataSources: {},
})
