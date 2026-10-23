import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { itemsSource } from "../src/schema.ts"

const themes = [
  ["Brand foundations", "A practical identity system for our next chapter."],
  ["Customer discovery", "Turn interviews into clear product opportunities."],
  ["Design library", "Build reusable patterns that make everyday work easier."],
  ["Editorial calendar", "Plan thoughtful stories for the people we serve."],
  ["Field notes", "Collect small observations and promising ideas."],
  ["Launch playbook", "Bring the team together around a confident release."],
  [
    "Mobile experience",
    "Make the essentials feel natural on a smaller screen.",
  ],
  [
    "Research archive",
    "Keep useful evidence close to the decisions it informs.",
  ],
  ["Studio website", "A welcoming home for our work, process, and people."],
  ["Team rituals", "Make space for shared context, feedback, and focus."],
  ["Usability sessions", "Learn where people get stuck and what helps."],
  ["Welcome guide", "Give every new teammate a useful first week."],
]
const countArg = process.argv.find((arg) => arg.startsWith("--count="))
const count = countArg ? Number(countArg.slice(8)) : 36
if (!Number.isInteger(count) || count < 0 || count > 100000)
  throw new Error("Use --count=0…100000")
const path = "data/worker_items.json"
if (existsSync(path) && !process.argv.includes("--overwrite")) {
  console.log(
    `${path} already exists; use --overwrite to reset local preview data.`
  )
} else {
  const stageOptions = [
    { name: "Backlog", color: "gray" },
    { name: "In progress", color: "blue" },
    { name: "Done", color: "green" },
  ]
  const rows = Array.from({ length: count }, (_, index) => {
    const theme = themes[index % themes.length]
    if (!theme) throw new Error("Missing sample theme")
    return {
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      name: `${theme[0]} ${String(index + 1).padStart(4, "0")}`,
      summary: theme[1],
      stage:
        stageOptions[
          (index + Math.floor(index / themes.length)) % stageOptions.length
        ]?.name,
      due: {
        type: "date",
        start_date: `2026-11-${String((index % 28) + 1).padStart(2, "0")}`,
      },
      owner: [],
      image: "",
      rating: (index % 5) + 1,
    }
  })
  mkdirSync("data", { recursive: true })
  writeFileSync(
    path,
    JSON.stringify(
      {
        type: "worker",
        name: "Studio projects",
        icon: "🗂️",
        schema: {
          ...itemsSource.properties,
          stage: {
            ...itemsSource.properties.stage,
            options: stageOptions.map((option, index) => ({
              id: `stage-${index}`,
              ...option,
            })),
          },
        },
        rows,
      },
      undefined,
      2
    ) + "\n"
  )
  console.log(
    `Seeded ${count} local projects in ${path}. No Notion workspace was changed.`
  )
}
