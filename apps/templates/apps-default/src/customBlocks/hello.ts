import { customBlock } from "@notionhq/apps"

export default customBlock({
  path: "./blocks/hello",
  slashCommand: "app-hello",
  dataSources: {},
})
