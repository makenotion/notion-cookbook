import { triggers } from "@notionhq/workers/alpha/triggers";
import { createWorkflow } from "@notionhq/workers/alpha/workflow";

export default createWorkflow({
  name: "Say Hello",
  description: "Says hello on a recurring schedule.",
  triggers: [triggers.recurrence()],
  handler: async (_event, context) => {
    await context.step("Say hello", () => {
      console.log("Hello from your workflow!");
    });
  },
});
