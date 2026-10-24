/**
 * Tools are generally available.
 */

import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"

const worker = new Worker()
export default worker

worker.tool("myTool", {
  title: "My Tool",
  // Description of what this tool does - shown to the AI agent
  description: "Search for items by keyword or ID",
  // Use the schema builder to define input — it auto-sets required and
  // additionalProperties, and provides type inference.
  schema: j.object({
    query: j.string().describe("The search query").nullable(),
    limit: j.number().describe("Maximum number of results").nullable(),
  }),
  // Optional: schema for the output the tool returns
  outputSchema: j.object({
    results: j.array(j.string()),
  }),
  // The function that executes when the tool is called
  execute: async (input, { notion: _notion }) => {
    // Destructure input with default values
    const { query: _query, limit: _limit = 10 } = input

    // Perform your logic here
    // Example: search your data source using the query and limit
    const results: string[] = []

    // Return data matching your outputSchema (if provided)
    return { results }
  },
})
