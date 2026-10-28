import { Worker } from "@notionhq/workers"
import { itemsSource } from "./schema.js"

const worker = new Worker()
export default worker

for (const view of ["table", "board", "gallery", "list", "feed"]) {
  worker.customBlock(view, {
    path: `./blocks/${view}`,
    command: "npx vite build --base=./",
    output: "dist",
    name: `Collection ${view[0].toUpperCase()}${view.slice(1)}`,
    description: `An editable ${view} view of a mapped Notion database.`,
    icon: { type: "emoji", emoji: "🗂️" },
    slashCommand: `collection-${view}`,
    version: 1,
    dataSources: { items: itemsSource },
  })
}
