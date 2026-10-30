import { connections } from "@notionhq/apps"

// The person who installs the App picks the channel in setup.
export default connections.slack({
  krillion: {
    description: "Channel where people post Krillion scores",
    permissions: "write",
    multiple: false,
  },
})
