import { triggers } from "@notionhq/apps/triggers"
import { createWorkflow } from "@notionhq/apps/workflow"

export default createWorkflow({
  name: "Say Hello",
  description: "Says hello on a recurring schedule.",
  triggers: [triggers.scheduled()],
  handler: async (_event, context) => {
    await context.step("Say hello", () => {
      console.log("Hello from your workflow!")
    })
  },
})
