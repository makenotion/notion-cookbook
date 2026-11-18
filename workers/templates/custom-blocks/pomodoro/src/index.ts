import { Worker } from "@notionhq/workers"

const worker = new Worker()
export default worker

worker.customBlock("pomodoro", {
  name: "Pomodoro",
  icon: { type: "emoji", emoji: "🍅" },
  path: "./blocks/pomodoro",
  command: "npx vite build",
  output: "dist",
  description: "A focus timer with short and long breaks.",
  slashCommand: "pomodoro",
  version: 1,
  dataSources: {},
})
