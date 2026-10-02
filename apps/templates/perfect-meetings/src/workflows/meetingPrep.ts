import { access, workflow } from "@notionhq/apps"
import { FatalError } from "@notionhq/apps/error"

import { queryAll, read } from "../lib/props.js"
import { pageIdFromEvent } from "../lib/notionIds.js"
import { MEETING_STATUS, companies, meetings, people } from "../notion.js"
import {
  BACKLOG_LOOKBACK_DAYS,
  companyAttempted,
  personAttempted,
  selectBacklog,
  type BacklogMeeting,
} from "./lib/backlog.js"
import {
  prepConnections,
  prepTargets,
  runPrep,
  splitEmails,
} from "./lib/prep.js"
import { needsResearch, readyForResearch } from "./lib/research.js"
import { isRuntimeSignal } from "./lib/runtime.js"

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export default workflow({
  name: "Prepare research",
  description:
    "Prepares calendar context, then hands meetings to the researcher with Ready. Run manually to queue unresearched people and companies too. No agent session is awaited.",
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
    // Researches every person and company not yet researched, a capped
    // number of meetings per run. It takes no input.
    events.manual(),
  ],
  access: {
    meetings: access.edit(meetings.dataSource),
    people: access.edit(people.dataSource),
    companies: access.edit(companies.dataSource),
  },
  handler: async (event, context) => {
    const targets = prepTargets(context.access)
    if (event.type === "workflow.manual") {
      const picks = await context.step("Find research backlog", async () => {
        const now = Date.now()
        const [meetingPages, personPages, companyPages] = await Promise.all([
          queryAll(context.notion, {
            data_source_id: targets.meetings,
            filter: {
              and: [
                {
                  property: "When",
                  date: {
                    on_or_after: new Date(
                      now - BACKLOG_LOOKBACK_DAYS * DAY_MS
                    ).toISOString(),
                  },
                },
                {
                  property: "Status",
                  select: { does_not_equal: MEETING_STATUS.cancelled },
                },
              ],
            },
          }),
          queryAll(context.notion, { data_source_id: targets.people }),
          queryAll(context.notion, { data_source_id: targets.companies }),
        ])
        const backlogMeetings = meetingPages.flatMap(
          (page): BacklogMeeting[] => {
            const when = read.date(page.properties, "When")
            if (!when) return []
            const startMs = Date.parse(when.start)
            const endMs = when.end ? Date.parse(when.end) : startMs + HOUR_MS
            if (Number.isNaN(startMs)) return []
            return [
              {
                id: page.id,
                startMs,
                endMs: Number.isNaN(endMs) ? startMs + HOUR_MS : endMs,
                prepStatus: read.select(page.properties, "Prep status"),
                lastEditedMs: page.last_edited_time
                  ? Date.parse(page.last_edited_time)
                  : null,
                attendees: splitEmails(
                  read.text(page.properties, "Attendee emails")
                ),
              },
            ]
          }
        )
        const profilesToQueue = [...personPages, ...companyPages]
          .filter((page) => needsResearch(page.properties))
          .map((page) => page.id)
        const backlogPeople = personPages.flatMap((page) => {
          const email = read.email(page.properties, "Email")?.toLowerCase()
          if (!email) return []
          return [
            {
              email,
              companyDomain: read
                .text(page.properties, "Company domain")
                .trim()
                .toLowerCase(),
              attempted:
                Boolean(read.select(page.properties, "Research status")) ||
                personAttempted({
                  researchedAt:
                    read.date(page.properties, "Researched at")?.start ?? null,
                  role: read.text(page.properties, "Role"),
                  confidence: read.select(page.properties, "Confidence"),
                }),
            },
          ]
        })
        const attemptedCompanies = new Set(
          companyPages.flatMap((page) =>
            Boolean(read.select(page.properties, "Research status")) ||
            companyAttempted({
              researchedAt:
                read.date(page.properties, "Researched at")?.start ?? null,
              summary: read.text(page.properties, "Summary"),
            })
              ? [read.text(page.properties, "Domain").trim().toLowerCase()]
              : []
          )
        )
        const backlog = selectBacklog(
          backlogMeetings,
          backlogPeople,
          attemptedCompanies,
          now
        )
        for (const pick of backlog.picks)
          console.log(`Preparing ${pick.id}: ${pick.reasons.join(", ")}`)
        if (backlog.picks.length === 0)
          console.log("No meeting briefs need preparing")
        if (backlog.remaining > 0)
          console.log(
            `${backlog.remaining} more meeting(s) still need research; run this workflow again to continue`
          )
        return {
          meetings: backlog.picks.map((pick) => pick.id),
          profiles: profilesToQueue,
        }
      })
      for (const pageId of picks.profiles) {
        await context.step(
          "Queue profile research",
          { key: ["profile-ready", pageId] },
          () => readyForResearch(context.notion, pageId).then(() => null)
        )
      }

      // Each meeting's steps are keyed by its page ID, so one failing does
      // not stop the others; failures are reported at the end.
      const failures: string[] = []
      for (const meetingId of picks.meetings) {
        try {
          await runPrep(context, targets, meetingId, "force")
        } catch (error) {
          if (isRuntimeSignal(error)) throw error
          failures.push(`${meetingId}: ${(error as Error).message}`)
        }
      }
      if (failures.length > 0)
        throw new Error(
          `Research failed for ${failures.length} meeting(s):\n${failures.join("\n")}`
        )
      return
    }
    const pageId = pageIdFromEvent({
      url: event.url,
      page: event.type === "notion.page.created" ? event.page : undefined,
    })
    if (!pageId)
      throw new FatalError("The page event did not identify a meeting page")
    const reason = event.type === "notion.page.created" ? "created" : "updated"
    await runPrep(context, targets, pageId, reason)
  },
})
