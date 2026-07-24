import { Worker } from "@notionhq/workers"

const worker = new Worker()
export default worker

worker.customBlock("habitTracker", {
  path: "./blocks/habit-tracker",
  command: "npx vite build",
  output: "dist",
  version: 1,
  dataSources: {
    habits: {
      name: "Habits",
      description: "One row per habit being tracked.",
      icon: { type: "emoji", emoji: "🌱" },
      properties: {
        name: {
          name: "Name",
          type: "title",
        },
        icon: {
          name: "Icon",
          description: "An emoji shown next to the habit name, e.g. 🏃",
          type: "rich_text",
        },
        color: {
          name: "Color",
          description:
            "One of: yellow, blue, pink, green, purple, red, orange, teal",
          type: "select",
        },
      },
    },
    log: {
      name: "Habits Log",
      description:
        "One row per completed habit per day. A row's existence means the habit was done that day.",
      icon: { type: "emoji", emoji: "✅" },
      properties: {
        name: {
          name: "Name",
          type: "title",
        },
        date: {
          name: "Date",
          type: "date",
        },
        habit: {
          name: "Habit",
          description: "Relation to the Habits database",
          type: "relation",
        },
      },
    },
  },
})
