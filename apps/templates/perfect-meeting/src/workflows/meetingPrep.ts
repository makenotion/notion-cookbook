import { access, workflow } from "@notionhq/apps"
import { FatalError } from "@notionhq/apps/error"
import { j } from "@notionhq/apps/schema-builder"

import { formatId, pageIdFromEvent } from "../lib/notionIds.js"
import { companies, meetings, people, researcher } from "../notion.js"
import { prepConnections, prepTargets, runPrep } from "./lib/prep.js"

export default workflow({
  name: "Meeting prep",
  description:
    "Researches a meeting's company, attendees, and recent email, then writes the brief at the top of the meeting page.",
  connections: prepConnections,
  triggers: ({ events }) => [
    events.notionPageCreated({ dataSource: meetings.dataSource }),
    events.notionPageUpdated({
      dataSource: meetings.dataSource,
      properties: [
        meetings.dataSource.properties["Regenerate prep"],
        meetings.dataSource.properties["Attendee emails"],
      ],
    }),
    // Debugging: preps one meeting as if the given trigger had fired.
    events.manual({
      inputSchema: j.object({
        meeting: j.string().describe("Meetings page URL or ID"),
        reason: j
          .enum("created", "updated", "force")
          .nullable()
          .describe(
            "Which trigger to simulate; force (default) rewrites the brief even for past meetings"
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
    if (event.type === "workflow.manual") {
      const input = event.input.meeting.trim()
      const pageId =
        pageIdFromEvent({ url: input }) ??
        (/^[0-9a-f]{32}$/i.test(input) ? formatId(input) : null)
      if (!pageId)
        throw new FatalError("Manual input 'meeting' is not a page URL or ID")
      const reason = event.input.reason ?? "force"
      await runPrep(context, prepTargets(context.access), pageId, reason)
      return
    }
    const pageId = pageIdFromEvent({
      url: event.url,
      page: event.type === "notion.page.created" ? event.page : undefined,
    })
    if (!pageId)
      throw new FatalError("The page event did not identify a meeting page")
    const reason = event.type === "notion.page.created" ? "created" : "updated"
    await runPrep(context, prepTargets(context.access), pageId, reason)
  },
})
