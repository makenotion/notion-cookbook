import { access, workflow } from "@notionhq/apps"
import { FatalError } from "@notionhq/apps/error"
import { connections } from "@notionhq/apps/workflow"

import {
  SCAN_DAYS_AHEAD,
  SCAN_DAYS_BACK,
  TIME_ZONE,
  includeInternalAttendees,
} from "../lib/config.js"
import { pageIdFromEvent } from "../lib/notionIds.js"
import {
  MEETING_STATUS,
  RUN_STATUS,
  RUN_TRIGGER,
  companies,
  meetings,
  people,
  syncRuns,
} from "../notion.js"
import {
  allEventIds,
  diagnoseListEvents,
  meetingsFromListEvents,
  type ListEventsScriptOutput,
} from "./lib/calendar.js"
import {
  attendeesToWrite,
  cancelMeeting,
  contactsByEmail,
  loadStoredMeetings,
  upsertMeetings,
} from "./lib/ingest.js"
import { ensureRelations } from "./lib/relations.js"
import {
  finishRun,
  isRunRequest,
  startRun,
  type RunTrigger,
} from "./lib/runs.js"
import { isRuntimeSignal } from "./lib/runtime.js"

const DAY_MS = 24 * 60 * 60 * 1000

export default workflow({
  name: "Sync calendar",
  description:
    "Reads your calendar and adds meetings with outside attendees to Meetings, and their attendees and companies to People and Companies. Runs hourly, on calendar changes, or whenever you run it.",
  connections: {
    calendar: connections.calendar({
      targets: {
        meetings: {
          description: "Meetings to sync and watch for changes",
          permissions: "read",
          multiple: true,
        },
      },
    }),
  },
  triggers: ({ events, connections }) => [
    events.calendarEventCreated({
      calendars: connections.calendar.targets.meetings,
    }),
    events.calendarEventUpdated({
      calendars: connections.calendar.targets.meetings,
    }),
    events.calendarEventCanceled({
      calendars: connections.calendar.targets.meetings,
    }),
    // Hourly catch-up. It also marks meetings cancelled when their event is
    // cancelled or deleted.
    events.scheduled({
      frequency: "hour",
      interval: 1,
      start: "2026-09-28T00:05:00",
      timeZone: TIME_ZONE,
    }),
    // Adding a row to Workflow runs runs a calendar catch-up.
    events.notionPageCreated({ dataSource: syncRuns.dataSource }),
    // Run a calendar catch-up on demand. It takes no input.
    events.manual(),
  ],
  // Full access: the first run adds relation properties to the schemas.
  access: {
    meetings: access.fullAccess(meetings.dataSource),
    people: access.fullAccess(people.dataSource),
    companies: access.fullAccess(companies.dataSource),
    runs: access.edit(syncRuns.dataSource),
  },
  handler: async (event, context) => {
    // Every run is logged in Workflow runs. A row a person adds is the request
    // itself; rows this workflow logs also fire the page trigger and are
    // ignored here.
    let requestPageId: string | null = null
    if (event.type === "notion.page.created") {
      requestPageId = pageIdFromEvent({ url: event.url, page: event.page })
      if (!requestPageId)
        throw new FatalError(
          "The page event did not identify a Workflow runs row"
        )
      const pageId = requestPageId
      const requested = await context.step("Check run request", () =>
        isRunRequest(context.notion, pageId)
      )
      if (!requested) return
    }

    const runPageId = await context.step("Log run started", () =>
      startRun(context.notion, context.access.runs.id, {
        requestPageId,
        trigger: runTrigger(event.type),
        runId: context.runId,
        startedAt: new Date().toISOString(),
      })
    )
    try {
      await ingest()
    } catch (error) {
      if (isRuntimeSignal(error)) throw error
      // Keyed per attempt: a retry that succeeds overwrites this with Success.
      await context.step(
        "Log run failed",
        { key: ["log-run-failed", String(context.attemptNumber)] },
        () =>
          finishRun(
            context.notion,
            runPageId,
            RUN_STATUS.failed,
            (error as Error).message
          )
      )
      throw error
    }
    await context.step("Log run finished", () =>
      finishRun(context.notion, runPageId, RUN_STATUS.success)
    )

    async function ingest(): Promise<void> {
      const ids = {
        meetings: context.access.meetings.id,
        people: context.access.people.id,
        companies: context.access.companies.id,
      }

      // Every trigger is the same full catch-up of the scan window.
      const window = await context.step("Choose scan window", () => {
        const now = Date.now()
        return {
          timeMin: new Date(now - SCAN_DAYS_BACK * DAY_MS).toISOString(),
          timeMax: new Date(now + SCAN_DAYS_AHEAD * DAY_MS).toISOString(),
        }
      })

      const scan = await context.step("List calendar events", async () => {
        const output = await context.connections.calendar.listEvents({
          calendars: context.connections.calendar.targets.meetings,
          timeMin: window.timeMin,
          timeMax: window.timeMax,
          timeZone: TIME_ZONE,
        })
        const typed = output as ListEventsScriptOutput
        const options = { includeInternal: includeInternalAttendees() }
        return {
          meetings: meetingsFromListEvents(typed, options),
          complete: output.errors.length === 0,
          eventIds: allEventIds(typed),
          errors: output.errors.map((error) => error.error),
          // Saved with the step so run logs explain an empty result.
          diagnostics: diagnoseListEvents(typed, options),
        }
      })

      await context.step("Ensure relations", () =>
        ensureRelations(context.notion, ids)
      )

      const stored = await context.step("Load stored meetings", () =>
        loadStoredMeetings(context.notion, ids.meetings, window.timeMin)
      )

      // Calendar events often omit attendee names; the account's contacts fill
      // in names and photos. Best effort: ingest continues without them.
      const emails = attendeesToWrite(scan.meetings, stored)
      const contacts =
        emails.length === 0
          ? {}
          : await context.step("Look up contacts", async () => {
              try {
                const output = await context.connections.calendar.listContacts({
                  calendars: context.connections.calendar.targets.meetings,
                  queries: emails,
                })
                const found = contactsByEmail(output, emails)
                console.log(
                  `Contacts matched ${Object.keys(found).length} of ${emails.length} attendees`
                )
                return found
              } catch (error) {
                console.warn(
                  `Contact lookup failed: ${(error as Error).message}`
                )
                return {}
              }
            })

      const result = await upsertMeetings(
        context.step,
        context.notion,
        ids,
        scan.meetings,
        stored,
        contacts
      )

      // A full, error-free scan that no longer returns a stored meeting's event
      // at all means the event was deleted. Events that still exist but no longer
      // pass the attendee filter (for example a debugging run that included
      // coworkers) are left alone.
      if (scan.complete) {
        const seen = new Set(scan.eventIds)
        const missing = Object.entries(stored).filter(([eventId, meeting]) => {
          const start = meeting.start ? Date.parse(meeting.start) : Number.NaN
          return (
            !seen.has(eventId) &&
            meeting.status !== MEETING_STATUS.cancelled &&
            start >= Date.parse(window.timeMin) &&
            start <= Date.parse(window.timeMax)
          )
        })
        for (const [eventId, meeting] of missing) {
          await context.step(
            "Mark meeting cancelled",
            { key: ["cancel", eventId] },
            () => cancelMeeting(context.notion, meeting.pageId)
          )
        }
      }

      await context.step("Report ingest", () => {
        console.log(
          `Meetings created: ${result.created}, updated: ${result.updated}`
        )
      })
    }
  },
})

function runTrigger(type: string): RunTrigger {
  if (type.startsWith("calendar.event.")) return RUN_TRIGGER.calendar
  if (type === "recurrence") return RUN_TRIGGER.hourly
  if (type === "notion.page.created") return RUN_TRIGGER.runNow
  return RUN_TRIGGER.manual
}
