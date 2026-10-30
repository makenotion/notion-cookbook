import { events, workflow } from "@notionhq/apps"

import slack from "../connections/slack.js"
import { buildLeaderboard } from "./lib/leaderboard.js"

const DAY_MS = 24 * 60 * 60 * 1000

export default workflow({
  name: "Post Krillion leaderboard",
  description:
    "Posts the top Krillion scores from the last day in the Krillion channel: daily at 6 pm Pacific time, or whenever you run it.",
  triggers: [
    events.scheduled({
      frequency: "day",
      interval: 1,
      start: "2026-10-30T18:00:00",
      timeZone: "America/Los_Angeles",
    }),
    events.manual(),
  ],
  handler: async (_event, context) => {
    const leaderboard = await context.step("Read scores", async () => {
      const threads = await slack.getThreadsInChannelSince({
        channel: slack.krillion,
        timestamp: new Date(Date.now() - DAY_MS).toISOString(),
      })
      // Each result is the first message of its thread. Replies are chat.
      const posts = threads.flatMap(([first]) =>
        first?.from.type === "user"
          ? [
              {
                userId: first.from.id,
                message: first.message,
                timestamp: first.timestamp,
              },
            ]
          : []
      )
      return buildLeaderboard(posts)
    })

    if (!leaderboard) {
      console.log("Nobody posted a Krillion score in the last day")
      return
    }
    await context.step("Post leaderboard", () =>
      slack.createThreadInChannel({
        channel: slack.krillion,
        message: leaderboard,
      })
    )
  },
})
