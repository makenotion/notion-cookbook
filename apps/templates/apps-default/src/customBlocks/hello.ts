import { createCustomBlock } from "@notionhq/apps/custom-block"

export default createCustomBlock({
  path: "./blocks/hello",
  slashCommand: "app-hello",
  dataSources: {},
})
