import { access, workflow } from "@notionhq/apps"
import { FatalError } from "@notionhq/apps/error"
import { j } from "@notionhq/apps/schema-builder"
import { connections } from "@notionhq/apps/workflow"

import {
  SCAN_DAYS_AHEAD,
  SCAN_DAYS_BACK,
  TIME_ZONE,
  includeInternalAttendees,
} from "../lib/config.js"
import {
  MEETING_STATUS,
  companies,
  meetings,
  people,
  runNow,
} from "../notion.js"
import {
  allEventIds,
  currentOrNextMeeting,
  diagnoseListEvents,
  meetingsFromListEvents,
  type ListEventsScriptOutput,
} from "./lib/calendar.js"
import {
  attendeesToWrite,
  cancelMeeting,
  contactsByEmail,
  findMeetingByEventId,
  loadStoredMeetings,
  upsertMeetings,
} from "./lib/ingest.js"
import { ensureRelations } from "./lib/relations.js"

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export default workflow({
  name: "Calendar ingest",
  description:
    "Adds calendar meetings with outside attendees to Meetings, and their attendees and companies to People and Companies.",
  connections: {
    calendar: connections.calendar({
      permissions: "read",
      readTeammatesCalendars: false,
    }),
  },
  triggers: ({ events }) => [
    events.calendarEventCreated({ connectionKey: "calendar" }),
    events.calendarEventUpdated({ connectionKey: "calendar" }),
    events.calendarEventCanceled({ connectionKey: "calendar" }),
    // Hourly backfill catches anything the event triggers missed.
    events.scheduled({
      frequency: "hour",
      interval: 1,
      start: "2026-09-28T00:05:00",
      timeZone: TIME_ZONE,
    }),
    events.notionPageCreated({ dataSource: runNow.dataSource }),
    // Debugging: replays any of the triggers above on demand.
    events.manual({
      inputSchema: j.object({
        mode: j
          .enum("backfill", "event", "cancel", "next")
          .describe(
            "backfill = hourly/Run now scan; event = calendar created/updated; cancel = calendar cancelled; next = only your current or next meeting"
          ),
        eventStartTime: j
          .datetime()
          .nullable()
          .describe(
            "For mode=event: the event's start time; scans one hour either side"
          ),
        eventId: j
          .string()
          .nullable()
          .describe(
            "For mode=cancel: the calendar event ID stored in Meetings"
          ),
        includeInternal: j
          .boolean()
          .nullable()
          .describe(
            "Treat coworkers as outside attendees for this run only (defaults to INCLUDE_INTERNAL_ATTENDEES)"
          ),
      }),
    }),
  ],
  // Full access: the first run adds relation properties to the schemas.
  access: {
    meetings: access.fullAccess(meetings.dataSource),
    people: access.fullAccess(people.dataSource),
    companies: access.fullAccess(companies.dataSource),
  },
  handler: async (event, context) => {
    const ids = {
      meetings: context.access.meetings.id,
      people: context.access.people.id,
      companies: context.access.companies.id,
    }

    // Map every trigger, including the manual one, onto the three code paths.
    const manual = event.type === "workflow.manual" ? event.input : null
    if (manual?.mode === "event" && !manual.eventStartTime) {
      throw new FatalError("Manual mode=event needs eventStartTime")
    }
    if (manual?.mode === "cancel" && !manual.eventId)
      throw new FatalError("Manual mode=cancel needs eventId")

    const cancelledEventId =
      event.type === "calendar.event.canceled"
        ? event.eventId
        : manual?.mode === "cancel"
          ? manual.eventId
          : null
    if (cancelledEventId) {
      const pageId = await context.step("Find cancelled meeting", () =>
        findMeetingByEventId(context.notion, ids.meetings, cancelledEventId)
      )
      if (pageId) {
        await context.step("Mark meeting cancelled", () =>
          cancelMeeting(context.notion, pageId)
        )
      }
      return
    }

    // Event triggers rescan a small window around the changed event, so the
    // meeting is read in the same shape the backfill uses. Other triggers
    // scan the full window and also reconcile meetings that disappeared.
    const eventStart =
      event.type === "calendar.event.created" ||
      event.type === "calendar.event.updated"
        ? event.startTime
        : manual?.mode === "event"
          ? manual.eventStartTime
          : null
    const isEventTrigger = eventStart !== null
    const window = await context.step("Choose scan window", () => {
      if (eventStart !== null) {
        const start = Date.parse(eventStart)
        return {
          timeMin: new Date(start - HOUR_MS).toISOString(),
          timeMax: new Date(start + HOUR_MS).toISOString(),
        }
      }
      const now = Date.now()
      return {
        timeMin: new Date(now - SCAN_DAYS_BACK * DAY_MS).toISOString(),
        timeMax: new Date(now + SCAN_DAYS_AHEAD * DAY_MS).toISOString(),
      }
    })

    const scan = await context.step("List calendar events", async () => {
      const output = await context.connections.calendar.listEvents({
        timeMin: window.timeMin,
        timeMax: window.timeMax,
        timeZone: TIME_ZONE,
      })
      const typed = output as ListEventsScriptOutput
      const options = {
        includeInternal: manual?.includeInternal ?? includeInternalAttendees(),
      }
      const found = meetingsFromListEvents(typed, options)
      const next =
        manual?.mode === "next" ? currentOrNextMeeting(found, Date.now()) : null
      if (next)
        console.log(
          `Current or next meeting: "${next.title}" (${next.attendees.length} attendees)`
        )
      return {
        meetings: manual?.mode === "next" ? (next ? [next] : []) : found,
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
                queries: emails,
              })
              const found = contactsByEmail(output, emails)
              console.log(
                `Contacts matched ${Object.keys(found).length} of ${emails.length} attendees`
              )
              return found
            } catch (error) {
              console.warn(`Contact lookup failed: ${(error as Error).message}`)
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
    if (!isEventTrigger && manual?.mode !== "next" && scan.complete) {
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
  },
})
