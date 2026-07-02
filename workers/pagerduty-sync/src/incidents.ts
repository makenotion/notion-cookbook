// PagerDuty incidents — the active operational view for responders and
// stakeholders. Keep schema and transform property order exactly aligned.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"

import type { PagerDutyIncident } from "./pagerduty.js"
import {
  boundedText,
  dateTime,
  durationMinutes,
  humanizeEnum,
  incidentPageContent,
  latestDateTime,
  nextAutomaticAction,
  providerOptionLabel,
  referenceOptionName,
  referenceOptionNames,
  safeWebUrl,
  MAX_RICH_TEXT_CHARACTERS,
} from "./helpers.js"

export const INITIAL_TITLE = "PagerDuty Incidents"
export const PRIMARY_KEY = "PagerDuty Incident ID"

export const incidentSchema = {
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
} satisfies Schema.Schema<typeof PRIMARY_KEY>

const ASSIGNED_VIA_LABELS: Record<string, string> = {
  escalation_policy: "Escalation Policy",
  direct_assignment: "Direct Assignment",
}

export function incidentToChange(
  incident: PagerDutyIncident
): SyncChangeUpsert<typeof PRIMARY_KEY, typeof incidentSchema.properties> {
  const title =
    boundedText(incident.title, MAX_RICH_TEXT_CHARACTERS) ?? incident.id
  const status = providerOptionLabel(humanizeEnum(incident.status))
  const urgency = providerOptionLabel(humanizeEnum(incident.urgency))
  const assignedTo = referenceOptionNames(
    "Assigned To",
    incident.assignments?.map((assignment) => assignment.assignee)
  )
  const incidentLink = safeWebUrl(incident.html_url)
  const serviceId = incident.service?.id.trim()
  const incidentType = providerOptionLabel(
    boundedText(
      humanizeEnum(incident.incident_type?.name),
      MAX_RICH_TEXT_CHARACTERS
    )
  )
  const lastChangedBy = referenceOptionName(incident.last_status_change_by)
  const nextAction = nextAutomaticAction(incident.pending_actions)
  const nextActionLabel = providerOptionLabel(nextAction?.label)
  const conferenceLink = safeWebUrl(incident.conference_bridge?.conference_url)
  const conferenceDialIn = boundedText(
    incident.conference_bridge?.conference_number,
    MAX_RICH_TEXT_CHARACTERS
  )
  const priority = referenceOptionName(incident.priority)
  const teams = referenceOptionNames("Teams", incident.teams)
  const escalationPolicy = referenceOptionName(incident.escalation_policy)
  const lastStatusChange = dateTime(incident.last_status_change_at)
  const updated = dateTime(incident.updated_at)
  const totalAlertCount = incident.alert_counts?.all
  const activeAlertCount = incident.alert_counts?.triggered

  // PagerDuty exposes only current acknowledgements here (the list is empty
  // after retrigger or resolution), so do not present this as lifetime data.
  const acknowledgedBy = referenceOptionNames(
    "Acknowledged By",
    incident.acknowledgements?.map(
      (acknowledgement) => acknowledgement.acknowledger
    )
  )
  const lastAcknowledged = latestDateTime(
    incident.acknowledgements?.map((acknowledgement) => acknowledgement.at)
  )
  const assignedViaValue = incident.assigned_via?.trim()
  const assignedVia = providerOptionLabel(
    assignedViaValue
      ? (ASSIGNED_VIA_LABELS[assignedViaValue] ??
          humanizeEnum(assignedViaValue))
      : null
  )
  const created = dateTime(incident.created_at)
  const resolved = dateTime(incident.resolved_at)
  const resolutionDuration = durationMinutes(created, resolved)
  const pageContent = incidentPageContent(incident)

  return {
    type: "upsert" as const,
    // PagerDuty's immutable incident ID is the sync identity.
    key: incident.id,
    upstreamUpdatedAt: incident.updated_at,
    pageContentMarkdown: pageContent,
    properties: {
      Title: Builder.title(title),
      Status: status ? Builder.select(status) : [],
      Urgency: urgency ? Builder.select(urgency) : [],
      "Assigned To":
        assignedTo.length > 0 ? Builder.multiSelect(...assignedTo) : [],
      "Incident Link": incidentLink ? Builder.url(incidentLink) : [],
      Service: serviceId ? [Builder.relation(serviceId)] : [],
      "Incident Type": incidentType ? Builder.select(incidentType) : [],
      "Last Changed By": lastChangedBy ? Builder.select(lastChangedBy) : [],
      "Next Automatic Action": nextActionLabel
        ? Builder.select(nextActionLabel)
        : [],
      "Next Action At": nextAction ? Builder.dateTime(nextAction.at) : [],
      "Conference Link": conferenceLink ? Builder.url(conferenceLink) : [],
      "Conference Dial-in": conferenceDialIn
        ? Builder.richText(conferenceDialIn)
        : [],
      "Resolution Duration (min)":
        resolutionDuration != null ? Builder.number(resolutionDuration) : [],
      Priority: priority ? Builder.select(priority) : [],
      Teams: teams.length > 0 ? Builder.multiSelect(...teams) : [],
      "Escalation Policy": escalationPolicy
        ? Builder.select(escalationPolicy)
        : [],
      "Last Status Change": lastStatusChange
        ? Builder.dateTime(lastStatusChange)
        : [],
      Updated: updated ? Builder.dateTime(updated) : [],
      "Total Alert Count":
        typeof totalAlertCount === "number" && Number.isFinite(totalAlertCount)
          ? Builder.number(totalAlertCount)
          : [],
      "Active Alert Count":
        typeof activeAlertCount === "number" &&
        Number.isFinite(activeAlertCount)
          ? Builder.number(activeAlertCount)
          : [],
      "Acknowledged By":
        acknowledgedBy.length > 0 ? Builder.multiSelect(...acknowledgedBy) : [],
      "Last Acknowledged": lastAcknowledged
        ? Builder.dateTime(lastAcknowledged)
        : [],
      "Assigned Via": assignedVia ? Builder.select(assignedVia) : [],
      Created: created ? Builder.dateTime(created) : [],
      Resolved: resolved ? Builder.dateTime(resolved) : [],
      "Incident Number":
        typeof incident.incident_number === "number" &&
        Number.isFinite(incident.incident_number)
          ? Builder.number(incident.incident_number)
          : [],
      "PagerDuty Incident ID": Builder.richText(incident.id),
    },
  }
}
