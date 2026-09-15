import { workflow } from "@notionhq/apps"
import { triggers } from "@notionhq/apps/triggers"

export default workflow({
  name: "Say Hello",
  description: "Says hello on a recurring schedule.",
  triggers: [triggers.scheduled()],
  handler: async (_event, context) => {
    await context.step("Say hello", () => {
      console.log("Hello from your workflow!")
    })
  },
})
