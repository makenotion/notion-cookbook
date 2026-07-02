// PagerDuty incidents — the active operational view for responders and
// stakeholders. Keep schema and transform property order exactly aligned.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"

import type { PagerDutyIncident } from "./pagerduty.js"
import {
  boundedText,
  dateTime,
  durationMinutes,
  humanizeEnum,
  incidentPageContent,
  latestDateTime,
  nextAutomaticAction,
  referenceName,
  referenceNames,
  safeWebUrl,
  MAX_RICH_TEXT_CHARACTERS,
} from "./helpers.js"

export const INITIAL_TITLE = "PagerDuty Incidents"
export const PRIMARY_KEY = "PagerDuty Incident ID"

export const incidentSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("alarm", "red"),
  properties: {
    Title: Schema.title(),

    Status: Schema.select([
      { name: "Triggered" },
      { name: "Acknowledged" },
      { name: "Resolved" },
    ]),

    Urgency: Schema.select([{ name: "High" }, { name: "Low" }]),

    "Assigned To": Schema.multiSelect([]),

    "Incident Link": Schema.url(),

    // Relation values use the immutable service key; users see service pages.
    Service: Schema.relation("services", {
      twoWay: true,
      relatedPropertyName: "Incidents",
    }),

    // Incident types are configured by each PagerDuty account.
    "Incident Type": Schema.select([]),

    // The actor may be a user, service, or integration.
    "Last Changed By": Schema.select([]),

    "Next Automatic Action": Schema.select([]),

    "Next Action At": Schema.date(),

    "Conference Link": Schema.url(),

    "Conference Dial-in": Schema.richText(),

    "Resolution Duration (min)": Schema.number(),

    // Priorities are account-configured, so their options are dynamic.
    Priority: Schema.select([]),

    Teams: Schema.multiSelect([]),

    "Escalation Policy": Schema.select([]),

    "Last Status Change": Schema.date(),

    Updated: Schema.date(),

    "Total Alert Count": Schema.number(),

    "Active Alert Count": Schema.number(),

    "Acknowledged By": Schema.multiSelect([]),

    "Last Acknowledged": Schema.date(),

    "Assigned Via": Schema.select([
      { name: "Escalation Policy" },
      { name: "Direct Assignment" },
    ]),

    Created: Schema.date(),

    Resolved: Schema.date(),

    "Incident Number": Schema.number(),

    "PagerDuty Incident ID": Schema.richText(),
  },
}

const ASSIGNED_VIA_LABELS: Record<string, string> = {
  escalation_policy: "Escalation Policy",
  direct_assignment: "Direct Assignment",
}

export function incidentToChange(incident: PagerDutyIncident) {
  const title =
    boundedText(incident.title, MAX_RICH_TEXT_CHARACTERS) ?? incident.id
  const status = humanizeEnum(incident.status)
  const urgency = humanizeEnum(incident.urgency)
  const assignedTo = referenceNames(
    incident.assignments?.map((assignment) => assignment.assignee)
  )
  const incidentLink = safeWebUrl(incident.html_url)
  const serviceId = incident.service?.id.trim()
  const incidentType = boundedText(
    humanizeEnum(incident.incident_type?.name),
    MAX_RICH_TEXT_CHARACTERS
  )
  const lastChangedBy = referenceName(incident.last_status_change_by)
  const nextAction = nextAutomaticAction(incident.pending_actions)
  const conferenceLink = safeWebUrl(incident.conference_bridge?.conference_url)
  const conferenceDialIn = boundedText(
    incident.conference_bridge?.conference_number,
    MAX_RICH_TEXT_CHARACTERS
  )
  const priority = referenceName(incident.priority)
  const teams = referenceNames(incident.teams)
  const escalationPolicy = referenceName(incident.escalation_policy)
  const lastStatusChange = dateTime(incident.last_status_change_at)
  const updated = dateTime(incident.updated_at)
  const totalAlertCount = incident.alert_counts?.all
  const activeAlertCount = incident.alert_counts?.triggered

  // PagerDuty exposes only current acknowledgements here (the list is empty
  // after retrigger or resolution), so do not present this as lifetime data.
  const acknowledgedBy = referenceNames(
    incident.acknowledgements?.map(
      (acknowledgement) => acknowledgement.acknowledger
    )
  )
  const lastAcknowledged = latestDateTime(
    incident.acknowledgements?.map((acknowledgement) => acknowledgement.at)
  )
  const assignedViaValue = incident.assigned_via?.trim()
  const assignedVia = assignedViaValue
    ? (ASSIGNED_VIA_LABELS[assignedViaValue] ?? humanizeEnum(assignedViaValue))
    : null
  const created = dateTime(incident.created_at)
  const resolved = dateTime(incident.resolved_at)
  const resolutionDuration = durationMinutes(created, resolved)
  const pageContent = incidentPageContent(incident)

  return {
    type: "upsert" as const,
    // PagerDuty's immutable incident ID is the sync identity.
    key: incident.id,
    upstreamUpdatedAt: incident.updated_at,
    ...(pageContent ? { pageContentMarkdown: pageContent } : {}),
    properties: {
      Title: Builder.title(title),
      ...(status ? { Status: Builder.select(status) } : {}),
      ...(urgency ? { Urgency: Builder.select(urgency) } : {}),
      ...(assignedTo.length > 0
        ? { "Assigned To": Builder.multiSelect(...assignedTo) }
        : {}),
      ...(incidentLink ? { "Incident Link": Builder.url(incidentLink) } : {}),
      ...(serviceId ? { Service: [Builder.relation(serviceId)] } : {}),
      ...(incidentType
        ? { "Incident Type": Builder.select(incidentType) }
        : {}),
      ...(lastChangedBy
        ? { "Last Changed By": Builder.select(lastChangedBy) }
        : {}),
      ...(nextAction
        ? {
            "Next Automatic Action": Builder.select(nextAction.label),
            "Next Action At": Builder.dateTime(nextAction.at),
          }
        : {}),
      ...(conferenceLink
        ? { "Conference Link": Builder.url(conferenceLink) }
        : {}),
      ...(conferenceDialIn
        ? { "Conference Dial-in": Builder.richText(conferenceDialIn) }
        : {}),
      ...(resolutionDuration != null
        ? {
            "Resolution Duration (min)": Builder.number(resolutionDuration),
          }
        : {}),
      ...(priority ? { Priority: Builder.select(priority) } : {}),
      ...(teams.length > 0 ? { Teams: Builder.multiSelect(...teams) } : {}),
      ...(escalationPolicy
        ? { "Escalation Policy": Builder.select(escalationPolicy) }
        : {}),
      ...(lastStatusChange
        ? { "Last Status Change": Builder.dateTime(lastStatusChange) }
        : {}),
      ...(updated ? { Updated: Builder.dateTime(updated) } : {}),
      ...(typeof totalAlertCount === "number" &&
      Number.isFinite(totalAlertCount)
        ? { "Total Alert Count": Builder.number(totalAlertCount) }
        : {}),
      ...(typeof activeAlertCount === "number" &&
      Number.isFinite(activeAlertCount)
        ? { "Active Alert Count": Builder.number(activeAlertCount) }
        : {}),
      ...(acknowledgedBy.length > 0
        ? { "Acknowledged By": Builder.multiSelect(...acknowledgedBy) }
        : {}),
      ...(lastAcknowledged
        ? { "Last Acknowledged": Builder.dateTime(lastAcknowledged) }
        : {}),
      ...(assignedVia ? { "Assigned Via": Builder.select(assignedVia) } : {}),
      ...(created ? { Created: Builder.dateTime(created) } : {}),
      ...(resolved ? { Resolved: Builder.dateTime(resolved) } : {}),
      ...(typeof incident.incident_number === "number" &&
      Number.isFinite(incident.incident_number)
        ? { "Incident Number": Builder.number(incident.incident_number) }
        : {}),
      "PagerDuty Incident ID": Builder.richText(incident.id),
    },
  }
}
