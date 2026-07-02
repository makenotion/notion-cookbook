// PagerDuty services — ownership and incident-routing configuration at a
// glance. Keep schema and transform property order exactly aligned.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"

import type { PagerDutyOnCall, PagerDutyService } from "./pagerduty.js"
import {
  boundedText,
  dateTime,
  humanizeEnum,
  MAX_RICH_TEXT_CHARACTERS,
  plainTextPageContent,
  positiveMinutes,
  referenceName,
  referenceNames,
  safeWebUrl,
  supportHoursLabel,
  urgencyRuleLabel,
} from "./helpers.js"

export const INITIAL_TITLE = "PagerDuty Services"
export const PRIMARY_KEY = "PagerDuty Service ID"

export const serviceSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("server", "blue"),
  properties: {
    Name: Schema.title(),

    "Response State": Schema.select([
      { name: "No Open Incidents" },
      { name: "Response in Progress" },
      { name: "Awaiting Response" },
      { name: "Maintenance" },
      { name: "Disabled" },
    ]),

    "Primary On Call": Schema.multiSelect([]),

    "Primary Coverage": Schema.select([
      { name: "Covered" },
      { name: "No Primary On Call" },
      { name: "No Escalation Policy" },
      { name: "Not Applicable" },
    ]),

    Teams: Schema.multiSelect([]),

    "Service Link": Schema.url(),

    "Coverage Checked": Schema.date(),

    Integrations: Schema.multiSelect([]),

    "Integration Count": Schema.number(),

    "Support Hours": Schema.richText(),

    "Last Incident": Schema.date(),

    "Escalation Policy": Schema.select([]),

    Description: Schema.richText(),

    // Support-hours rules are composed summaries rather than a stable enum.
    "Urgency Rule": Schema.richText(),

    "Auto Resolve (min)": Schema.number(),

    "Re-trigger After Ack (min)": Schema.number(),

    Created: Schema.date(),

    "PagerDuty Service ID": Schema.richText(),
  },
}

export type ServiceOperationalContextEntry = {
  covered: boolean
  primaryOnCall: readonly string[]
}

export type ServiceOperationalContext = ReadonlyMap<
  string,
  ServiceOperationalContextEntry
>

/**
 * Build a complete level-one coverage snapshot. Requested policies are seeded
 * as uncovered so a missing row means a real empty result, not an unqueried
 * policy. On-calls outside that explicit scope are ignored.
 */
export function buildServiceOperationalContext(
  requestedPolicyIds: readonly string[],
  onCalls: ReadonlyArray<PagerDutyOnCall>
): ServiceOperationalContext {
  const mutable = new Map<
    string,
    { covered: boolean; primaryOnCall: Set<string> }
  >()

  for (const rawPolicyId of requestedPolicyIds) {
    const policyId = rawPolicyId.trim()
    if (policyId && !mutable.has(policyId)) {
      mutable.set(policyId, { covered: false, primaryOnCall: new Set() })
    }
  }

  for (const onCall of onCalls) {
    if (onCall.escalation_level !== 1) continue
    const policyId = onCall.escalation_policy?.id.trim()
    if (!policyId) continue

    const entry = mutable.get(policyId)
    if (!entry) continue
    entry.covered = true

    const user = referenceName(onCall.user)
    if (user) entry.primaryOnCall.add(user)
  }

  return new Map(
    [...mutable].map(([policyId, entry]) => [
      policyId,
      {
        covered: entry.covered,
        primaryOnCall: [...entry.primaryOnCall].sort(),
      },
    ])
  )
}

const RESPONSE_STATE_LABELS: Record<string, string> = {
  active: "No Open Incidents",
  warning: "Response in Progress",
  critical: "Awaiting Response",
  maintenance: "Maintenance",
  disabled: "Disabled",
}

function coverageForService(
  service: PagerDutyService,
  operationalContext: ServiceOperationalContext
): {
  label:
    | "Covered"
    | "No Primary On Call"
    | "No Escalation Policy"
    | "Not Applicable"
  primaryOnCall: readonly string[]
} {
  const status = service.status.trim().toLowerCase()
  const policyId = service.escalation_policy?.id.trim()
  const entry = policyId ? operationalContext.get(policyId) : undefined

  if (status === "disabled") {
    return {
      label: "Not Applicable",
      primaryOnCall: entry?.primaryOnCall ?? [],
    }
  }
  if (!policyId) {
    return { label: "No Escalation Policy", primaryOnCall: [] }
  }
  if (!entry) {
    throw new Error(
      `PagerDuty service ${service.id} uses escalation policy ${policyId}, but that policy is absent from the on-call coverage snapshot.`
    )
  }

  return {
    label: entry.covered ? "Covered" : "No Primary On Call",
    primaryOnCall: entry.primaryOnCall,
  }
}

/**
 * Services do not expose an updated timestamp. The sync passes one observation
 * time per polling cycle so configuration and status changes are reconsidered.
 */
export function serviceToChange(
  service: PagerDutyService,
  observedAt: string,
  operationalContext: ServiceOperationalContext
) {
  const name = boundedText(service.name, MAX_RICH_TEXT_CHARACTERS) ?? service.id
  const statusValue = service.status.trim().toLowerCase()
  const responseState =
    RESPONSE_STATE_LABELS[statusValue] ?? humanizeEnum(service.status)
  const coverage = coverageForService(service, operationalContext)
  const teams = referenceNames(service.teams)
  const serviceLink = safeWebUrl(service.html_url)
  const integrations = referenceNames(service.integrations)
  const integrationCount = service.integrations
    ? new Set(
        service.integrations
          .map((integration) => integration.id.trim())
          .filter(Boolean)
      ).size
    : null
  const supportHours = supportHoursLabel(service.support_hours)
  const lastIncident = dateTime(service.last_incident_timestamp)
  const escalationPolicy = referenceName(service.escalation_policy)
  const description = boundedText(service.description, MAX_RICH_TEXT_CHARACTERS)
  const descriptionPageContent = plainTextPageContent(service.description)
  const urgencyRule = urgencyRuleLabel(service.incident_urgency_rule)
  const autoResolveMinutes = positiveMinutes(service.auto_resolve_timeout)
  const retriggerMinutes = positiveMinutes(service.acknowledgement_timeout)
  const created = dateTime(service.created_at)

  return {
    type: "upsert" as const,
    key: service.id,
    upstreamUpdatedAt: observedAt,
    ...(descriptionPageContent
      ? { pageContentMarkdown: descriptionPageContent }
      : {}),
    properties: {
      Name: Builder.title(name),
      ...(responseState
        ? { "Response State": Builder.select(responseState) }
        : {}),
      ...(coverage.primaryOnCall.length > 0
        ? {
            "Primary On Call": Builder.multiSelect(...coverage.primaryOnCall),
          }
        : {}),
      "Primary Coverage": Builder.select(coverage.label),
      ...(teams.length > 0 ? { Teams: Builder.multiSelect(...teams) } : {}),
      ...(serviceLink ? { "Service Link": Builder.url(serviceLink) } : {}),
      "Coverage Checked": Builder.dateTime(observedAt),
      ...(integrations.length > 0
        ? { Integrations: Builder.multiSelect(...integrations) }
        : {}),
      ...(integrationCount != null
        ? { "Integration Count": Builder.number(integrationCount) }
        : {}),
      ...(supportHours
        ? { "Support Hours": Builder.richText(supportHours) }
        : {}),
      ...(lastIncident
        ? { "Last Incident": Builder.dateTime(lastIncident) }
        : {}),
      ...(escalationPolicy
        ? { "Escalation Policy": Builder.select(escalationPolicy) }
        : {}),
      ...(description ? { Description: Builder.richText(description) } : {}),
      ...(urgencyRule ? { "Urgency Rule": Builder.richText(urgencyRule) } : {}),
      ...(autoResolveMinutes != null
        ? { "Auto Resolve (min)": Builder.number(autoResolveMinutes) }
        : {}),
      ...(retriggerMinutes != null
        ? {
            "Re-trigger After Ack (min)": Builder.number(retriggerMinutes),
          }
        : {}),
      ...(created ? { Created: Builder.dateTime(created) } : {}),
      "PagerDuty Service ID": Builder.richText(service.id),
    },
  }
}
