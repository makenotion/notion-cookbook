import { workflow } from "@notionhq/apps"
import { events } from "@notionhq/apps/events"

export default workflow({
  name: "Say Hello",
  description: "Says hello on a recurring schedule.",
  triggers: [events.scheduled()],
  handler: async (_event, context) => {
    await context.step("Say hello", () => {
      console.log("Hello from your workflow!")
    })
  },
})
