import type { NotionDataSourcePage } from "@notionhq/apps/custom-blocks"

import { MORNING_PREP_TIME, TIME_ZONE } from "../../src/lib/schedule"
import { researchActivity } from "./derive"
import type { QueryState } from "./live"
import { dateRange, splitEmails, text } from "./meeting"
import { PREP, researchStuck, type BlockState } from "./state"

export type SetupStage = {
  key: string
  title: string
  detail: string
  status: "pending" | "active" | "complete" | "attention"
  completed?: number
  total?: number
}

export type SetupQueries = {
  people: QueryState<NotionDataSourcePage>
  companies: QueryState<NotionDataSourcePage>
  meetings: QueryState<NotionDataSourcePage>
}

/** Format the configured wall-clock time without converting it to the viewer's zone. */
export function morningScheduleLabel(now: number): string {
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(`2000-01-01T${MORNING_PREP_TIME}:00Z`))
  const zone =
    new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      timeZoneName: "longGeneric",
    })
      .formatToParts(now)
      .find((part) => part.type === "timeZoneName")?.value ?? TIME_ZONE
  return `${time} ${zone}`
}

export function setupStages(
  state: Exclude<BlockState, { kind: "ready" }>,
  queries: SetupQueries,
  requestPending: boolean,
  now: number
): SetupStage[] {
  const started = state.kind !== "never_run" || requestPending
  const calendarDone = state.kind === "researching" && !requestPending
  const calendarAttention =
    !requestPending &&
    (state.kind === "failed" || ("stale" in state && state.stale))
  const calendar: SetupStage = {
    key: "calendar",
    title: calendarDone
      ? "Calendar synced"
      : calendarAttention
        ? "Calendar sync needs attention"
        : started
          ? "Syncing calendar"
          : "Sync calendar",
    detail: !started
      ? "Find your upcoming meetings"
      : requestPending || state.kind === "waiting"
        ? "Waiting for sync to start"
        : calendarDone && queries.meetings.hasData
          ? `${queries.meetings.items.length}${queries.meetings.hasMore ? "+" : ""} meetings found`
          : calendarAttention
            ? "Try syncing again"
            : "Finding meetings and outside attendees",
    status: calendarAttention
      ? "attention"
      : calendarDone
        ? "complete"
        : started
          ? "active"
          : "pending",
  }

  const research = (
    key: keyof SetupQueries,
    singular: string,
    plural: string
  ): SetupStage => {
    const query = queries[key]
    const briefs = key === "meetings"
    const initialTitle = briefs
      ? "Prepare meeting briefs"
      : `Research ${plural}`
    const initialDetail = briefs
      ? "Turn completed research into a useful brief"
      : key === "people"
        ? "Get to know the people you'll meet"
        : "Learn about their companies"
    if (!started)
      return {
        key,
        title: initialTitle,
        detail: initialDetail,
        status: "pending",
      }
    if (!query.hasData)
      return {
        key,
        title: initialTitle,
        detail: query.error
          ? "Couldn't load progress"
          : "Waiting for research updates",
        status: query.error ? "attention" : "pending",
      }

    const rows = briefs
      ? query.items.filter((row) => {
          if (
            text(row.propertiesByKey.Status) === "Cancelled" ||
            !splitEmails(text(row.propertiesByKey["Attendee emails"])).length
          )
            return false
          const range = dateRange(row.propertiesByKey.When)
          return (
            text(row.propertiesByKey["Prep status"]) === PREP.researching ||
            (range !== null && range.endMs > now)
          )
        })
      : query.items
    const counts = researchActivity(
      briefs
        ? rows.map((row) => ({
            ...row,
            propertiesByKey: {
              ...row.propertiesByKey,
              "Research status":
                ({ Ready: "Done", Queued: "Ready" } as Record<string, string>)[
                  text(row.propertiesByKey["Prep status"])
                ] ?? text(row.propertiesByKey["Prep status"]),
            },
          }))
        : rows,
      now
    )
    const stalled = counts.stalled
    const noun = counts.total === 1 ? singular : plural
    const busy = counts.researching > 0
    const complete =
      calendarDone &&
      !query.hasMore &&
      !query.error &&
      counts.done === counts.total
    const attention =
      Boolean(query.error) || (!busy && (counts.failed > 0 || stalled > 0))
    const waitingForProfiles = briefs
      ? rows.filter(
          (row) =>
            text(row.propertiesByKey["Prep status"]) === PREP.queued &&
            !text(row.propertiesByKey["Research status"]) &&
            !researchStuck(row, now)
        ).length
      : 0
    const detail = [
      counts.researching > 0 && `${counts.researching} researching`,
      counts.total > 0
        ? counts.done > 0 && `${counts.done} ${briefs ? "ready" : "complete"}`
        : calendarDone
          ? "None to research"
          : "Waiting for calendar results",
      waitingForProfiles > 0 && `${waitingForProfiles} waiting for research`,
      counts.queued > waitingForProfiles &&
        `${counts.queued - waitingForProfiles} queued`,
      counts.failed > 0 && `${counts.failed} failed`,
      stalled > 0 && `${stalled} may be stuck`,
      counts.unrequested > 0 && `${counts.unrequested} not queued`,
      query.hasMore && "partial counts",
      query.error && "couldn't refresh",
    ]
      .filter(Boolean)
      .join(" · ")
    return {
      key,
      title:
        counts.total === 0
          ? complete
            ? `No ${plural} to ${briefs ? "prepare" : "research"}`
            : initialTitle
          : complete
            ? `${counts.total} ${noun} ${briefs ? "ready" : "researched"}`
            : attention
              ? `${briefs ? "Meeting prep" : key === "people" ? "Participant research" : "Company research"} needs attention`
              : `${counts.total} ${noun}`,
      detail,
      status: attention
        ? "attention"
        : complete
          ? "complete"
          : busy
            ? "active"
            : "pending",
      completed: counts.done,
      total: counts.total,
    }
  }
  return [
    calendar,
    research("people", "participant", "participants"),
    research("companies", "company", "companies"),
    research("meetings", "meeting brief", "meeting briefs"),
  ]
}
