import { access, workflow } from "@notionhq/apps"

import { MORNING_PREP_TIME, TIME_ZONE } from "../lib/config.js"
import { queryAll, read } from "../lib/props.js"
import { localDay, startsOnDay } from "../lib/time.js"
import { MEETING_STATUS, companies, meetings, people } from "../notion.js"
import { prepTargets, runPrep } from "./lib/prep.js"
import { isRuntimeSignal } from "./lib/runtime.js"

const DAY_MS = 24 * 60 * 60 * 1000

export default workflow({
  name: "Refresh today's research",
  description:
    "Prepares fresh context, waits for participant and company research, and queues today's briefs: daily at 7:45 am local time, or whenever you run it.",
  triggers: ({ events }) => [
    events.scheduled({
      frequency: "day",
      interval: 1,
      start: `2026-09-29T${MORNING_PREP_TIME}:00`,
      timeZone: TIME_ZONE,
    }),
    // Refresh today's briefs on demand. It takes no input.
    events.manual(),
  ],
  access: {
    meetings: access.edit(meetings.dataSource),
    people: access.edit(people.dataSource),
    companies: access.edit(companies.dataSource),
  },
  handler: async (_event, context) => {
    const todays = await context.step("Find today's meetings", async () => {
      const day = localDay(Date.now(), TIME_ZONE)
      // Query a padded range, then keep meetings that start on the local day:
      // all-day dates and date-times compare differently against a filter.
      const pages = await queryAll(context.notion, {
        data_source_id: context.access.meetings.id,
        filter: {
          and: [
            {
              property: "When",
              date: {
                on_or_after: new Date(day.startMs - DAY_MS).toISOString(),
              },
            },
            {
              property: "When",
              date: { before: new Date(day.endMs + DAY_MS).toISOString() },
            },
            {
              property: "Status",
              select: { does_not_equal: MEETING_STATUS.cancelled },
            },
          ],
        },
        sorts: [{ property: "When", direction: "ascending" }],
      })
      return pages
        .filter((page) => {
          const start = read.date(page.properties, "When")?.start
          return start !== undefined && startsOnDay(start, day)
        })
        .map((page) => page.id)
    })

    // Each meeting's steps are keyed by its page ID, so one meeting failing
    // does not stop the others; failures are reported at the end.
    const failures: string[] = []
    for (const meetingId of todays) {
      try {
        await runPrep(
          context,
          prepTargets(context.access),
          meetingId,
          "morning"
        )
      } catch (error) {
        if (isRuntimeSignal(error)) throw error
        failures.push(`${meetingId}: ${(error as Error).message}`)
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Refresh today's research failed for ${failures.length} meeting(s):\n${failures.join("\n")}`
      )
    }
  },
})
