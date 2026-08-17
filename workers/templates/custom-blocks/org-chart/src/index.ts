import { Worker } from "@notionhq/workers"

const worker = new Worker()
export default worker

worker.customBlock("orgChart", {
  path: "./blocks/org-chart",
  command: "npx vite build",
  output: "dist",
  version: 1,
  dataSources: {
    people: {
      name: "People",
      description:
        "People in the organization. Each row is a person with a role and a relation to their manager.",
      icon: { type: "emoji", emoji: "🌳" },
      properties: {
        name: { name: "Name", type: "title" },
        role: {
          name: "Role",
          description: "The person's role or job title",
          type: "rich_text",
        },
        reportsTo: {
          name: "Reports to",
          description:
            "Relation to this person's manager (a row in the same database)",
          type: "relation",
        },
      },
    },
  },
})
