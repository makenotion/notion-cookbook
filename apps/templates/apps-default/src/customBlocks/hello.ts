import * as Notion from "@notionhq/apps"

export default Notion.customBlock({
  path: "./blocks/hello",
  slashCommand: "app-hello",
  dataSources: {},
})
