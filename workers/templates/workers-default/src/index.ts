import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"

const worker = new Worker()
export default worker

// Example agent tool that returns a greeting
// Delete this when you're ready to start building your own tools.
worker.tool("sayHello", {
  title: "Say Hello",
  description: "Returns a friendly greeting for the given name.",
  schema: j.object({
    name: j.string().describe("The name to greet."),
  }),
  execute: ({ name }) => `Hello, ${name}!`,
})
