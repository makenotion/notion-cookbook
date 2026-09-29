import { access, workflow } from "@notionhq/apps"
import { FatalError } from "@notionhq/apps/error"
import { j } from "@notionhq/apps/schema-builder"

import { MORNING_PREP_TIME, TIME_ZONE } from "../lib/config.js"
import { queryAll, read } from "../lib/props.js"
import { localDay, startsOnDay } from "../lib/time.js"
import {
  MEETING_STATUS,
  companies,
  meetings,
  people,
  researcher,
} from "../notion.js"
import { prepConnections, prepTargets, runPrep } from "./lib/prep.js"
import { isRuntimeSignal } from "./lib/runtime.js"

const DAY_MS = 24 * 60 * 60 * 1000

export default workflow({
  name: "Morning prep",
  description:
    "Refreshes the brief for every meeting happening today, at 7:45 am local time.",
  connections: prepConnections,
  triggers: ({ events }) => [
    events.scheduled({
      frequency: "day",
      interval: 1,
      start: `2026-09-29T${MORNING_PREP_TIME}:00`,
      timeZone: TIME_ZONE,
    }),
    // Refresh today's briefs on demand, optionally for another day.
    events.manual({
      inputSchema: j.object({
        date: j
          .date()
          .nullable()
          .describe(
            `Local date (YYYY-MM-DD) in ${TIME_ZONE}; defaults to today`
          ),
      }),
    }),
  ],
  access: {
    meetings: access.edit(meetings.dataSource),
    people: access.edit(people.dataSource),
    companies: access.edit(companies.dataSource),
    researcher: access.call(researcher),
  },
  handler: async (event, context) => {
    const date = event.type === "workflow.manual" ? event.input.date : null
    if (date && Number.isNaN(Date.parse(`${date}T12:00:00Z`)))
      throw new FatalError(`Invalid date "${date}"`)
    const todays = await context.step("Find today's meetings", async () => {
      // Midday UTC falls on the same local date in every zone within ±12h.
      const day = localDay(
        date ? Date.parse(`${date}T12:00:00Z`) : Date.now(),
        TIME_ZONE
      )
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
        `Morning prep failed for ${failures.length} meeting(s):\n${failures.join("\n")}`
      )
    }
  },
})
