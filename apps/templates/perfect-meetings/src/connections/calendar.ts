import { connection } from "@notionhq/apps"

// All workflows in this installation share these accounts and selections.
export const calendar = connection({
  type: "calendar",
  meetings: {
    description: "Meetings to sync and watch for changes",
    permissions: "read",
    multiple: true,
  },
  history: {
    description: "Read past meetings and contact names",
    permissions: "read",
    multiple: true,
  },
})
