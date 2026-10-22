import { connections } from "@notionhq/apps"

// All workflows in this installation share these accounts and selections.
export default connections.calendar({
  meetings: {
    description: "Calendars for meeting sync and research",
    permissions: "read",
    multiple: true,
  },
})
