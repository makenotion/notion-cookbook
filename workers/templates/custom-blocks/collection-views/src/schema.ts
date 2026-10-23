import type { ManifestDataSource } from "@notionhq/custom-blocks"

export const itemsSource = {
  name: "Projects",
  description:
    "One project per page. Map the same database into all five views.",
  properties: {
    name: { name: "Name", type: "title" },
    stage: {
      name: "Stage",
      type: "select",
      description:
        "Use your existing select options; sample: Backlog, In progress, Done.",
    },
    summary: { name: "Summary", type: "rich_text" },
    due: { name: "Due", type: "date" },
    owner: { name: "Owner", type: "people" },
    image: { name: "Image", type: "files" },
    rating: { name: "Rating", type: "number" },
  },
} satisfies ManifestDataSource
