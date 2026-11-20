import { Worker } from "@notionhq/workers"

const worker = new Worker()
export default worker

worker.customBlock("iconPicker", {
  path: "./blocks/icon-picker",
  command: "npx vite build",
  output: "dist",
  name: "Icon picker",
  description: "Search Notion icons, choose a color, and preview a page icon.",
  icon: { type: "notion", icon: "token", color: "purple" },
  slashCommand: "icon-picker",
  version: 1,
  dataSources: {},
})
