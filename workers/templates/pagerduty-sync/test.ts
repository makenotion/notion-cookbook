// Deterministic offline tests for the PagerDuty sync worker.
// Run from this directory with `npm test`.

import assert from "node:assert/strict"
import { test } from "node:test"

import { RateLimitError } from "@notionhq/workers"

import {
  durationMinutes,
  humanizeEnum,
  incidentPageContent,
  MAX_MULTI_SELECT_OPTIONS,
  MAX_OPTION_NAME_CHARACTERS,
  MAX_PAGE_CONTENT_CHARACTERS,
  MAX_URL_CHARACTERS,
  nextAutomaticAction,
  providerOptionLabel,
  providerOptionLabels,
  referenceName,
  safeWebUrl,
  supportHoursLabel,
  urgencyRuleLabel,
} from "./src/helpers.js"
import { incidentSchema, incidentToChange } from "./src/incidents.js"
import worker, { executeIncidents, executeServices } from "./src/index.js"
import {
  createPagerDutyClient,
  getPagerDutyConfig,
  parseRetryAfterSeconds,
  rateLimitRetryAfterSeconds,
  type PagerDutyConfig,
  type PagerDutyClient,
  type PagerDutyIncident,
  type PagerDutyOnCall,
  type PagerDutyOffsetPage,
  type PagerDutyService,
} from "./src/pagerduty.js"
import {
  buildServiceOperationalContext,
  serviceSchema,
  serviceToChange,
} from "./src/services.js"
import {
  INCIDENT_WINDOW_DAYS,
  initialIncidentSyncState,
  initialServiceSyncState,
  nextIncidentSyncState,
  nextServiceSyncState,
} from "./src/sync-state.js"

const TEST_TOKEN = "pagerduty-test-token"

function propertyText(value: unknown): string {
  return JSON.stringify(value)
}

function assertPropertyContains(value: unknown, expected: string): void {
  assert.match(
    propertyText(value),
    new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  )
}

const fullIncident: PagerDutyIncident = {
  id: "PINC001",
  incident_number: 4321,
  title: "Checkout latency above SLO",
  html_url: "https://acme.pagerduty.com/incidents/PINC001",
  status: "acknowledged",
  urgency: "high",
  priority: { id: "PPRI001", summary: "P1" },
  service: { id: "PSVC001", summary: "Checkout API" },
  assignments: [
    {
      at: "2026-07-02T12:01:00Z",
      assignee: { id: "PUSR001", summary: "Ada Lovelace" },
    },
    {
      at: "2026-07-02T12:02:00Z",
      assignee: { id: "PUSR001", summary: "Ada Lovelace" },
    },
    {
      at: "2026-07-02T12:03:00Z",
      assignee: { id: "PUSR002", name: "Grace Hopper" },
    },
  ],
  assigned_via: "direct_assignment",
  last_status_change_at: "2026-07-02T12:05:00Z",
  last_status_change_by: {
    id: "PAGENT1",
    type: "integration_reference",
    summary: "PagerDuty Automation",
  },
  resolved_at: null,
  incident_type: { name: "major_incident" },
  pending_actions: [
    { type: "resolve", at: "2026-07-02T12:30:00Z" },
    { type: "urgency_change", at: "2026-07-02T12:15:00Z", to: "high" },
    { type: "escalate", at: "2026-07-02T12:15:00Z" },
  ],
  conference_bridge: {
    conference_url: "https://meet.example.com/checkout",
    conference_number: "+1 415-555-1212,,,,1234#",
  },
  first_trigger_log_entry: {
    event_details: { description: "Latency breached the checkout SLO." },
    channel: {
      type: "email",
      body: "<p>Investigate the <strong>database</strong>.</p>",
      body_content_type: "text/html",
    },
    contexts: [
      {
        type: "link",
        text: "Runbook",
        href: "https://runbooks.example.com/checkout",
      },
      {
        type: "link",
        text: "Unsafe",
        href: "https://example.com/?access_token=must-not-appear",
      },
    ],
  },
  alert_counts: { all: 8, triggered: 2, resolved: 6 },
  escalation_policy: {
    id: "PPOL001",
    summary: "Commerce escalation",
  },
  teams: [
    { id: "PTEAM01", summary: "Commerce" },
    { id: "PTEAM01", summary: "Commerce" },
    { id: "PTEAM02", name: "SRE" },
  ],
  acknowledgements: [
    {
      at: "2026-07-02T12:04:00Z",
      acknowledger: { id: "PUSR001", summary: "Ada Lovelace" },
    },
    {
      at: "2026-07-02T12:06:00Z",
      acknowledger: { id: "PUSR001", summary: "Ada Lovelace" },
    },
  ],
  created_at: "2026-07-02T12:00:00Z",
  updated_at: "2026-07-02T12:45:30Z",
}

const minimalIncident: PagerDutyIncident = {
  id: "PINC002",
  incident_number: 4322,
  title: "  Unknown workflow state  ",
  html_url: null,
  status: "custom_new_state",
  urgency: null,
  priority: { id: "PPRI002" },
  service: null,
  assignments: [
    {
      at: "2026-07-02T13:00:00Z",
      assignee: { id: "PUSR003" },
    },
  ],
  assigned_via: null,
  last_status_change_at: null,
  resolved_at: null,
  first_trigger_log_entry: null,
  alert_counts: null,
  escalation_policy: null,
  teams: [],
  acknowledgements: [],
  created_at: "2026-07-02T13:00:00Z",
  updated_at: "2026-07-02T13:01:00Z",
}

const fullService: PagerDutyService = {
  id: "PSVC001",
  name: "Checkout API",
  description: `Owns checkout *and* payment routing. ${"x".repeat(2_100)}`,
  html_url: "https://acme.pagerduty.com/service-directory/PSVC001",
  status: "critical",
  created_at: "2024-01-02T03:04:05Z",
  last_incident_timestamp: "2026-07-02T12:00:00Z",
  escalation_policy: {
    id: "PPOL001",
    summary: "Commerce escalation",
  },
  teams: [
    { id: "PTEAM01", summary: "Commerce" },
    { id: "PTEAM01", summary: "Commerce" },
  ],
  integrations: [
    { id: "PINT001", summary: "Datadog" },
    { id: "PINT002", name: "CloudWatch" },
    { id: "PINT002", name: "CloudWatch" },
    { id: "PINT003" },
  ],
  auto_resolve_timeout: 14_400,
  acknowledgement_timeout: 600,
  incident_urgency_rule: {
    type: "use_support_hours",
    during_support_hours: { urgency: "high" },
    outside_support_hours: { urgency: "low" },
  },
  support_hours: {
    type: "fixed_time_per_day",
    time_zone: "America/New_York",
    days_of_week: [5, 1, 2, 3, 4, 2],
    start_time: "09:00:00",
    end_time: "17:00:00",
  },
}

const minimalService: PagerDutyService = {
  id: "PSVC002",
  name: "Internal tools",
  description: null,
  html_url: null,
  status: "experimental_state",
  created_at: "2025-02-03T04:05:06Z",
  last_incident_timestamp: null,
  escalation_policy: null,
  teams: [],
  integrations: [],
  auto_resolve_timeout: 0,
  acknowledgement_timeout: null,
  incident_urgency_rule: null,
  support_hours: null,
}

function numberedIncident(index: number): PagerDutyIncident {
  return {
    ...fullIncident,
    id: `P${String(100_000 + index)}`,
    incident_number: 10_000 + index,
  }
}

function numberedService(index: number): PagerDutyService {
  return {
    ...fullService,
    id: `P${String(200_000 + index)}`,
    name: `Service ${index}`,
  }
}

function onCall(overrides: Partial<PagerDutyOnCall> = {}): PagerDutyOnCall {
  return {
    escalation_policy: { id: "PPOL001", summary: "Commerce escalation" },
    user: { id: "PUSR001", summary: "Ada Lovelace" },
    schedule: { id: "PSCHED1", summary: "Primary rotation" },
    escalation_level: 1,
    start: "2026-07-02T08:00:00Z",
    end: "2026-07-02T16:00:00Z",
    ...overrides,
  }
}

function fullOperationalContext() {
  return buildServiceOperationalContext(
    ["PPOL001"],
    [
      onCall({ user: { id: "PUSR002", summary: "Grace Hopper" } }),
      onCall({ user: { id: "PUSR001", summary: "Ada Lovelace" } }),
      onCall({ user: { id: "PUSR003", summary: "Ada Lovelace" } }),
      onCall({
        escalation_level: 2,
        user: { id: "PUSR004", summary: "Ignored Level Two" },
      }),
    ]
  )
}

function config(overrides: Partial<PagerDutyConfig> = {}): PagerDutyConfig {
  return {
    region: "us",
    incidentLookbackDays: 90,
    serviceIds: [],
    teamIds: [],
    ...overrides,
  }
}

function incidentPage(
  resources: PagerDutyIncident[],
  options: Partial<PagerDutyOffsetPage<PagerDutyIncident>> = {}
): PagerDutyOffsetPage<PagerDutyIncident> {
  return {
    resources,
    offset: 0,
    limit: 100,
    total: resources.length,
    more: false,
    nextOffset: undefined,
    ...options,
  }
}

function servicePage(
  resources: PagerDutyService[],
  options: Partial<PagerDutyOffsetPage<PagerDutyService>> = {}
): PagerDutyOffsetPage<PagerDutyService> {
  return {
    resources,
    offset: 0,
    limit: 100,
    total: resources.length,
    more: false,
    nextOffset: undefined,
    ...options,
  }
}

test("worker manifest preserves user-first schemas, schedules, and shared pacing", () => {
  assert.deepEqual(
    worker.manifest.databases.map((database) => ({
      key: database.key,
      title: database.config.initialTitle,
      primaryKey: database.config.primaryKeyProperty,
      icon: database.config.schema.databaseIcon,
      firstSix: Object.keys(database.config.schema.properties).slice(0, 6),
    })),
    [
      {
        key: "incidents",
        title: "PagerDuty Incidents",
        primaryKey: "PagerDuty Incident ID",
        icon: { type: "notion", icon: "alarm", color: "red" },
        firstSix: [
          "Title",
          "Status",
          "Urgency",
          "Assigned To",
          "Incident Link",
          "Service",
        ],
      },
      {
        key: "services",
        title: "PagerDuty Services",
        primaryKey: "PagerDuty Service ID",
        icon: { type: "notion", icon: "server", color: "blue" },
        firstSix: [
          "Name",
          "Response State",
          "Primary On Call",
          "Primary Coverage",
          "Teams",
          "Service Link",
        ],
      },
    ]
  )

  type SyncConfig = {
    databaseKey: string
    mode: string
    schedule: { type: string; intervalMs: number }
  }
  assert.deepEqual(
    worker.manifest.capabilities.map((capability) => {
      assert.equal(capability._tag, "sync")
      const sync = capability.config as SyncConfig
      return {
        key: capability.key,
        databaseKey: sync.databaseKey,
        mode: sync.mode,
        intervalMs: sync.schedule.intervalMs,
      }
    }),
    [
      {
        key: "incidentsSync",
        databaseKey: "incidents",
        mode: "replace",
        intervalMs: 5 * 60_000,
      },
      {
        key: "servicesSync",
        databaseKey: "services",
        mode: "replace",
        intervalMs: 5 * 60_000,
      },
    ]
  )
  assert.deepEqual(worker.manifest.pacers, [
    {
      key: "pagerduty",
      config: { allowedRequests: 120, intervalMs: 60_000 },
    },
  ])
})

test("acknowledged incident maps available properties in schema order", () => {
  const change = incidentToChange(fullIncident)

  assert.equal(change.key, "PINC001")
  assert.equal(change.upstreamUpdatedAt, fullIncident.updated_at)
  assert.deepEqual(
    Object.keys(change.properties),
    Object.keys(incidentSchema.properties)
  )
  assertPropertyContains(change.properties.Title, "Checkout latency above SLO")
  assertPropertyContains(change.properties.Status, "Acknowledged")
  assertPropertyContains(change.properties["Assigned To"], "Ada Lovelace")
  assertPropertyContains(change.properties["Assigned To"], "Grace Hopper")
  assert.equal(
    propertyText(change.properties["Assigned To"]).match(/Ada Lovelace/g)
      ?.length,
    1
  )
  assertPropertyContains(change.properties.Service, "PSVC001")
  assertPropertyContains(change.properties["Incident Type"], "Major Incident")
  assertPropertyContains(
    change.properties["Last Changed By"],
    "PagerDuty Automation"
  )
  assertPropertyContains(change.properties["Next Automatic Action"], "Escalate")
  assertPropertyContains(change.properties["Next Action At"], "12:15")
  assertPropertyContains(
    change.properties["Conference Link"],
    "https://meet.example.com/checkout"
  )
  assertPropertyContains(
    change.properties["Conference Dial-in"],
    "+1 415-555-1212,,,,1234#"
  )
  assertPropertyContains(change.properties.Teams, "Commerce")
  assertPropertyContains(change.properties.Teams, "SRE")
  assertPropertyContains(change.properties["Assigned Via"], "Direct Assignment")
  assertPropertyContains(change.properties["Total Alert Count"], "8")
  assertPropertyContains(change.properties["Active Alert Count"], "2")
  assertPropertyContains(change.properties["Last Acknowledged"], "12:06")

  assert.ok(change.pageContentMarkdown)
  assert.match(change.pageContentMarkdown, /checkout SLO/)
  assert.match(change.pageContentMarkdown, /database/)
  assert.match(change.pageContentMarkdown, /Runbook/)
  assert.doesNotMatch(change.pageContentMarkdown, /must-not-appear/)
  assert.doesNotMatch(change.pageContentMarkdown, /<strong>/)
  assert.ok(change.pageContentMarkdown.length <= MAX_PAGE_CONTENT_CHARACTERS)

  const visible = propertyText(change.properties)
  assert.doesNotMatch(
    visible,
    /PUSR001|PUSR002|PTEAM01|PTEAM02|PPOL001|PAGENT1/
  )
})

test("resolved incident maps its resolution without stale current ownership", () => {
  const change = incidentToChange({
    ...fullIncident,
    status: "resolved",
    assignments: [],
    acknowledgements: [],
    resolved_at: "2026-07-02T12:45:00Z",
  })

  assertPropertyContains(change.properties.Resolved, "12:45")
  assertPropertyContains(change.properties["Resolution Duration (min)"], "45")
  assert.deepEqual(change.properties["Assigned To"], [])
  assert.deepEqual(change.properties["Acknowledged By"], [])
  assert.deepEqual(change.properties["Last Acknowledged"], [])
})

test("incident operational helpers are deterministic and omit unsafe values", () => {
  assert.deepEqual(
    nextAutomaticAction([
      { type: "urgency_change", at: "2026-07-02T12:10:00Z", to: "low" },
      { type: "urgency_change", at: "2026-07-02T12:10:00Z", to: "high" },
      { type: "resolve", at: "2026-07-02T12:20:00Z" },
      { type: "ignored", at: "not-a-date" },
    ]),
    {
      label: "Urgency Change to High",
      at: "2026-07-02T12:10:00Z",
    }
  )
  assert.equal(
    durationMinutes("2026-07-02T12:00:00Z", "2026-07-02T12:01:30Z"),
    1.5
  )
  assert.equal(
    durationMinutes("2026-07-02T12:01:00Z", "2026-07-02T12:00:00Z"),
    null
  )
  assert.equal(safeWebUrl("javascript:alert(1)"), null)
  assert.equal(
    safeWebUrl("https://meet.example.com/room?access_token=secret"),
    null
  )
  assert.equal(
    safeWebUrl("https://meet.example.com/room#access_token=secret"),
    null
  )
  assert.equal(
    safeWebUrl("https://meet.example.com/room#access%5Ftoken%3Dsecret"),
    null
  )
  assert.equal(
    safeWebUrl("https://meet.example.com/room#war-room"),
    "https://meet.example.com/room#war-room"
  )
  const urlPrefix = "https://example.com/"
  const maximumLengthUrl = `${urlPrefix}${"a".repeat(
    MAX_URL_CHARACTERS - urlPrefix.length
  )}`
  assert.equal(safeWebUrl(maximumLengthUrl), maximumLengthUrl)
  assert.equal(safeWebUrl(`${maximumLengthUrl}a`), null)

  const unsafeConference = incidentToChange({
    ...minimalIncident,
    html_url: "https://acme.pagerduty.com/incidents/PINC002#api_token=secret",
    conference_bridge: {
      conference_url: "https://user:password@meet.example.com/room",
      conference_number: "+1 212-555-0199",
    },
    resolved_at: "2026-07-02T12:59:00Z",
  })
  assert.deepEqual(unsafeConference.properties["Conference Link"], [])
  assert.deepEqual(unsafeConference.properties["Incident Link"], [])
  assertPropertyContains(
    unsafeConference.properties["Conference Dial-in"],
    "+1 212-555-0199"
  )
  assert.deepEqual(unsafeConference.properties["Resolution Duration (min)"], [])
})

test("incident alert counts preserve meaningful zero values", () => {
  const change = incidentToChange({
    ...minimalIncident,
    alert_counts: { all: 0, triggered: 0, resolved: 0 },
  })

  assertPropertyContains(change.properties["Total Alert Count"], "0")
  assertPropertyContains(change.properties["Active Alert Count"], "0")
})

test("minimal incident explicitly clears unresolved and absent values", () => {
  const change = incidentToChange(minimalIncident)

  assert.deepEqual(
    Object.keys(change.properties),
    Object.keys(incidentSchema.properties)
  )
  assertPropertyContains(change.properties.Title, "Unknown workflow state")
  assertPropertyContains(change.properties.Status, "Custom New State")
  assert.equal(change.pageContentMarkdown, "")
  assert.deepEqual(change.properties["Incident Link"], [])
  assert.deepEqual(change.properties["Assigned To"], [])
  assert.deepEqual(change.properties["Acknowledged By"], [])
  assert.deepEqual(change.properties.Priority, [])
  assert.deepEqual(change.properties.Service, [])
})

test("service transform preserves ownership, bounded content, and timeouts", () => {
  const observedAt = "2026-07-02T14:00:00.000Z"
  const change = serviceToChange(
    fullService,
    observedAt,
    fullOperationalContext()
  )

  assert.equal(change.key, "PSVC001")
  assert.equal(change.upstreamUpdatedAt, observedAt)
  assert.deepEqual(
    Object.keys(change.properties),
    Object.keys(serviceSchema.properties)
  )
  assertPropertyContains(
    change.properties["Response State"],
    "Awaiting Response"
  )
  assertPropertyContains(change.properties["Primary Coverage"], "Covered")
  const primaryOnCall = propertyText(change.properties["Primary On Call"])
  assert.match(primaryOnCall, /Ada Lovelace/)
  assert.match(primaryOnCall, /Grace Hopper/)
  assert.equal(primaryOnCall.match(/Ada Lovelace/g)?.length, 1)
  assert.ok(
    primaryOnCall.indexOf("Ada Lovelace") <
      primaryOnCall.indexOf("Grace Hopper")
  )
  assert.doesNotMatch(primaryOnCall, /Ignored Level Two/)
  assertPropertyContains(change.properties.Teams, "Commerce")
  assertPropertyContains(change.properties.Integrations, "Datadog")
  assertPropertyContains(change.properties.Integrations, "CloudWatch")
  assert.equal(
    propertyText(change.properties.Integrations).match(/CloudWatch/g)?.length,
    1
  )
  assertPropertyContains(change.properties["Integration Count"], "3")
  assertPropertyContains(
    change.properties["Support Hours"],
    "Mon–Fri 09:00–17:00 (America/New_York)"
  )
  assertPropertyContains(
    change.properties["Urgency Rule"],
    "High During Support Hours / Low Outside"
  )
  assertPropertyContains(change.properties["Auto Resolve (min)"], "240")
  assertPropertyContains(change.properties["Re-trigger After Ack (min)"], "10")
  assertPropertyContains(change.properties.Description, "truncated")
  assert.ok(change.pageContentMarkdown)
  assert.match(change.pageContentMarkdown, /\\\*and\\\*/)
})

test("minimal service explicitly clears timeouts and missing context", () => {
  const change = serviceToChange(
    {
      ...minimalService,
      html_url:
        "https://acme.pagerduty.com/service-directory/PSVC002?api_token=secret",
    },
    "2026-07-02T14:00:00.000Z",
    new Map()
  )

  assert.deepEqual(
    Object.keys(change.properties),
    Object.keys(serviceSchema.properties)
  )
  assertPropertyContains(
    change.properties["Response State"],
    "Experimental State"
  )
  assertPropertyContains(
    change.properties["Primary Coverage"],
    "No Escalation Policy"
  )
  assertPropertyContains(change.properties["Integration Count"], "0")
  assert.equal(change.pageContentMarkdown, "")
  assert.deepEqual(change.properties["Service Link"], [])
  assert.deepEqual(change.properties["Auto Resolve (min)"], [])
  assert.deepEqual(change.properties["Primary On Call"], [])
  assert.deepEqual(change.properties.Integrations, [])
  assert.deepEqual(change.properties["Support Hours"], [])
  assert.deepEqual(change.properties.Description, [])
})

test("complete upserts clear values that disappear from the same records", () => {
  const clearedIncident = incidentToChange({
    ...fullIncident,
    html_url: null,
    urgency: null,
    service: null,
    assignments: [],
    priority: null,
    incident_type: null,
    last_status_change_by: null,
    last_status_change_at: null,
    pending_actions: [],
    conference_bridge: null,
    teams: [],
    escalation_policy: null,
    alert_counts: null,
    acknowledgements: [],
    assigned_via: null,
    first_trigger_log_entry: null,
  })
  assert.equal(clearedIncident.key, fullIncident.id)
  assert.equal(clearedIncident.pageContentMarkdown, "")
  for (const property of [
    "Urgency",
    "Assigned To",
    "Incident Link",
    "Service",
    "Incident Type",
    "Last Changed By",
    "Next Automatic Action",
    "Next Action At",
    "Conference Link",
    "Conference Dial-in",
    "Resolution Duration (min)",
    "Priority",
    "Teams",
    "Escalation Policy",
    "Last Status Change",
    "Total Alert Count",
    "Active Alert Count",
    "Acknowledged By",
    "Last Acknowledged",
    "Assigned Via",
    "Resolved",
  ] as const) {
    assert.deepEqual(clearedIncident.properties[property], [])
  }

  const clearedService = serviceToChange(
    {
      ...fullService,
      html_url: null,
      teams: [],
      escalation_policy: null,
      description: null,
      integrations: [],
      support_hours: null,
      last_incident_timestamp: null,
      incident_urgency_rule: null,
      auto_resolve_timeout: null,
      acknowledgement_timeout: null,
    },
    "2026-07-02T14:00:00.000Z",
    new Map()
  )
  assert.equal(clearedService.key, fullService.id)
  assert.equal(clearedService.pageContentMarkdown, "")
  for (const property of [
    "Primary On Call",
    "Teams",
    "Service Link",
    "Integrations",
    "Support Hours",
    "Last Incident",
    "Escalation Policy",
    "Description",
    "Urgency Rule",
    "Auto Resolve (min)",
    "Re-trigger After Ack (min)",
  ] as const) {
    assert.deepEqual(clearedService.properties[property], [])
  }
  assertPropertyContains(clearedService.properties["Integration Count"], "0")
})

test("service response state and coverage distinguish every operational case", () => {
  const covered = fullOperationalContext()
  const gap = buildServiceOperationalContext(["PPOL001"], [])

  assert.deepEqual(covered.get("PPOL001"), {
    covered: true,
    primaryOnCall: ["Ada Lovelace", "Grace Hopper"],
  })
  assert.deepEqual(gap.get("PPOL001"), {
    covered: false,
    primaryOnCall: [],
  })

  const states = [
    ["active", "No Open Incidents"],
    ["warning", "Response in Progress"],
    ["critical", "Awaiting Response"],
    ["maintenance", "Maintenance"],
  ] as const
  for (const [status, expected] of states) {
    const change = serviceToChange(
      { ...fullService, status },
      "2026-07-02T14:00:00Z",
      covered
    )
    assertPropertyContains(change.properties["Response State"], expected)
    assertPropertyContains(change.properties["Primary Coverage"], "Covered")
  }

  const gapChange = serviceToChange(
    { ...fullService, status: "active" },
    "2026-07-02T14:00:00Z",
    gap
  )
  assertPropertyContains(
    gapChange.properties["Primary Coverage"],
    "No Primary On Call"
  )
  assert.deepEqual(gapChange.properties["Primary On Call"], [])

  const disabled = serviceToChange(
    { ...fullService, status: "disabled" },
    "2026-07-02T14:00:00Z",
    new Map()
  )
  assertPropertyContains(disabled.properties["Response State"], "Disabled")
  assertPropertyContains(
    disabled.properties["Primary Coverage"],
    "Not Applicable"
  )

  assert.throws(
    () => serviceToChange(fullService, "2026-07-02T14:00:00Z", new Map()),
    /absent from the on-call coverage snapshot/
  )
  assert.equal(
    supportHoursLabel(fullService.support_hours),
    "Mon–Fri 09:00–17:00 (America/New_York)"
  )
})

test("display and content helpers preserve unknowns while protecting secrets", () => {
  assert.equal(humanizeEnum("api"), "API")
  assert.equal(humanizeEnum("future_status"), "Future Status")
  assert.equal(referenceName({ id: "PUSR004" }), null)
  assert.equal(referenceName({ id: "PUSR004", name: "Named" }), "Named")
  assert.equal(
    urgencyRuleLabel({ type: "constant", urgency: "high" }),
    "Always High"
  )
  assert.equal(INCIDENT_WINDOW_DAYS, 7)

  const content = incidentPageContent({
    first_trigger_log_entry: {
      event_details: { description: "Safe trigger summary" },
      channel: {
        type: "api",
        description: "Safe monitoring description",
        details: {
          host: "sensitive-hostname",
          api_token: "must-not-appear",
        },
      },
      contexts: [
        {
          type: "link",
          text: "Credential URL",
          href: "https://user:password@example.com/runbook",
        },
      ],
    },
  })
  assert.match(content, /Safe trigger summary/)
  assert.match(content, /Safe monitoring description/)
  assert.doesNotMatch(content, /user:password/)
  assert.doesNotMatch(content, /sensitive-hostname|must-not-appear/)

  const webContent = incidentPageContent({
    first_trigger_log_entry: {
      channel: {
        type: "web_trigger",
        details: "Operator reported degraded checkout.",
      },
    },
  })
  assert.equal(webContent, "")
})

test("provider option labels satisfy Notion option constraints", () => {
  assert.equal(providerOptionLabel("  Payments,   US  "), "Payments， US")
  assert.equal(providerOptionLabel("ＡＰＩ"), "API")
  const forward = providerOptionLabels("Teams", [
    "sre",
    "Payments, US",
    "SRE",
    "  payments,   us ",
  ])
  const reverse = providerOptionLabels("Teams", [
    "  payments,   us ",
    "SRE",
    "Payments, US",
    "sre",
  ])
  assert.deepEqual(forward, reverse)
  assert.deepEqual(forward, ["Payments， US", "SRE"])
  assert.deepEqual(
    providerOptionLabels("Teams", ["Payments, US", "Payments · US"]),
    ["Payments · US", "Payments， US"]
  )

  const sharedPrefix = "Long option ".repeat(20)
  const longA = providerOptionLabel(`${sharedPrefix}alpha`)
  const longB = providerOptionLabel(`${sharedPrefix}beta`)
  assert.ok(longA)
  assert.ok(longB)
  assert.notEqual(longA, longB)
  assert.equal(Array.from(longA).length, MAX_OPTION_NAME_CHARACTERS)
  assert.equal(Array.from(longB).length, MAX_OPTION_NAME_CHARACTERS)
  assert.equal(providerOptionLabel(`${sharedPrefix}alpha`), longA)

  assert.equal(
    providerOptionLabels(
      "Teams",
      Array.from(
        { length: MAX_MULTI_SELECT_OPTIONS },
        (_, index) => `Team ${index}`
      )
    ).length,
    MAX_MULTI_SELECT_OPTIONS
  )
  assert.throws(
    () =>
      providerOptionLabels(
        "Teams",
        Array.from(
          { length: MAX_MULTI_SELECT_OPTIONS + 1 },
          (_, index) => `Team ${index}`
        )
      ),
    /at most 100 options/
  )

  const normalizedIncident = incidentToChange({
    ...minimalIncident,
    assignments: [
      {
        at: "2026-07-02T13:00:00Z",
        assignee: { id: "PUSR001", summary: "Doe, Jane" },
      },
      {
        at: "2026-07-02T13:01:00Z",
        assignee: { id: "PUSR002", summary: "doe, jane" },
      },
    ],
  })
  assertPropertyContains(
    normalizedIncident.properties["Assigned To"],
    "Doe， Jane"
  )
  assert.doesNotMatch(
    propertyText(normalizedIncident.properties["Assigned To"]),
    /doe， jane/
  )
})

test("configuration defaults, normalizes filters, and selects the EU host", () => {
  assert.deepEqual(getPagerDutyConfig({}), config())
  assert.deepEqual(
    getPagerDutyConfig({
      PAGERDUTY_REGION: " EU ",
      PAGERDUTY_INCIDENT_LOOKBACK_DAYS: "30",
      PAGERDUTY_SERVICE_IDS: "service-prod/v2, x,service-prod/v2",
      PAGERDUTY_TEAM_IDS: "team:platform,team:platform, team_lowercase",
    }),
    config({
      region: "eu",
      incidentLookbackDays: 30,
      serviceIds: ["service-prod/v2", "x"],
      teamIds: ["team:platform", "team_lowercase"],
    })
  )

  assert.throws(
    () => getPagerDutyConfig({ PAGERDUTY_REGION: "ap" }),
    /either "us" or "eu"/
  )
  assert.throws(
    () => getPagerDutyConfig({ PAGERDUTY_INCIDENT_LOOKBACK_DAYS: "180.5" }),
    /integer from 1 to 180/
  )
  assert.throws(
    () => getPagerDutyConfig({ PAGERDUTY_INCIDENT_LOOKBACK_DAYS: "181" }),
    /integer from 1 to 180/
  )
  const maximumLengthId = "x".repeat(255)
  assert.deepEqual(
    getPagerDutyConfig({ PAGERDUTY_SERVICE_IDS: maximumLengthId }).serviceIds,
    [maximumLengthId]
  )
  assert.throws(
    () =>
      getPagerDutyConfig({
        PAGERDUTY_SERVICE_IDS: `${maximumLengthId}x`,
      }),
    /longer than 255 characters/
  )
  assert.throws(
    () => getPagerDutyConfig({ PAGERDUTY_SERVICE_IDS: "service\nid" }),
    /control characters/
  )
  assert.throws(
    () => getPagerDutyConfig({ PAGERDUTY_SERVICE_IDS: "service\u0085id" }),
    /control characters/
  )
  for (const id of [".", ".."]) {
    assert.throws(
      () => getPagerDutyConfig({ PAGERDUTY_SERVICE_IDS: id }),
      /URL path segment/
    )
  }
  assert.deepEqual(getPagerDutyConfig({ PAGERDUTY_TEAM_IDS: "." }).teamIds, [
    ".",
  ])
  assert.throws(
    () => getPagerDutyConfig({ PAGERDUTY_TEAM_IDS: ",," }),
    /at least one PagerDuty ID/
  )
})

test("incident client sends pinned scope, embeds, auth, and pacing", async () => {
  let requestUrl: URL | undefined
  let requestInit: RequestInit | undefined
  let paced = 0
  const client = createPagerDutyClient({
    beforeRequest: async () => {
      paced++
    },
    getApiToken: () => TEST_TOKEN,
    fetch: async (input, init) => {
      requestUrl = new URL(String(input))
      requestInit = init
      return Response.json({
        incidents: [fullIncident],
        offset: 0,
        limit: 100,
        total: 1,
        more: false,
      })
    },
  })
  const scope = config({
    region: "eu",
    serviceIds: ["PSVC001", "PSVC002"],
    teamIds: ["PTEAM01"],
  })

  const page = await client.fetchIncidentsPage(scope, {
    since: "2026-07-01T00:00:00.000Z",
    until: "2026-07-02T00:00:00.000Z",
  })

  assert.equal(paced, 1)
  assert.equal(page.resources[0].id, "PINC001")
  assert.equal(page.nextOffset, undefined)
  assert.equal(requestUrl?.origin, "https://api.eu.pagerduty.com")
  assert.equal(requestUrl?.pathname, "/incidents")
  assert.equal(requestUrl?.searchParams.get("limit"), "100")
  assert.equal(requestUrl?.searchParams.get("total"), "true")
  assert.equal(requestUrl?.searchParams.get("date_range"), null)
  assert.deepEqual(requestUrl?.searchParams.getAll("statuses[]"), [])
  assert.equal(requestUrl?.searchParams.get("sort_by"), "incident_number:asc")
  assert.deepEqual(requestUrl?.searchParams.getAll("service_ids[]"), [
    "PSVC001",
    "PSVC002",
  ])
  assert.deepEqual(requestUrl?.searchParams.getAll("team_ids[]"), ["PTEAM01"])
  assert.deepEqual(requestUrl?.searchParams.getAll("include[]"), [
    "assignees",
    "acknowledgers",
    "priorities",
    "teams",
    "escalation_policies",
    "first_trigger_log_entries",
    "conference_bridge",
  ])

  const headers = new Headers(requestInit?.headers)
  assert.equal(headers.get("authorization"), `Token token=${TEST_TOKEN}`)
  assert.equal(
    headers.get("accept"),
    "application/vnd.pagerduty+json;version=2"
  )
  assert.equal(requestInit?.redirect, "error")
})

test("open incident traversal ignores age while retaining operational statuses", async () => {
  let requestUrl: URL | undefined
  const client = createPagerDutyClient({
    beforeRequest: async () => {},
    getApiToken: () => TEST_TOKEN,
    fetch: async (input) => {
      requestUrl = new URL(String(input))
      return Response.json({
        incidents: [fullIncident],
        offset: 0,
        limit: 100,
        total: 1,
        more: false,
      })
    },
  })

  await client.fetchIncidentsPage(config({ incidentPhase: "open" }), {
    since: "2026-01-01T00:00:00.000Z",
    until: "2026-07-02T00:00:00.000Z",
  })

  assert.equal(requestUrl?.searchParams.get("date_range"), "all")
  assert.deepEqual(requestUrl?.searchParams.getAll("statuses[]"), [
    "triggered",
    "acknowledged",
  ])
  assert.equal(requestUrl?.searchParams.get("since"), null)
  assert.equal(requestUrl?.searchParams.get("until"), null)
})

test("service client requests stable ordering and total counts", async () => {
  let requestUrl: URL | undefined
  const client = createPagerDutyClient({
    beforeRequest: async () => {},
    getApiToken: () => TEST_TOKEN,
    fetch: async (input) => {
      requestUrl = new URL(String(input))
      return Response.json({
        services: Array.from({ length: 100 }, (_, index) =>
          numberedService(index)
        ),
        offset: 100,
        limit: 100,
        total: 201,
        more: true,
      })
    },
  })

  const page = await client.fetchServicesPage(
    config({ teamIds: ["PTEAM01"] }),
    100
  )
  assert.equal(page.nextOffset, 200)
  assert.equal(requestUrl?.searchParams.get("sort_by"), "name:asc")
  // Service team ownership is current state, while incident team membership is
  // historical. Do not filter services by team or old incidents can lose their
  // relation target after a service moves between teams.
  assert.deepEqual(requestUrl?.searchParams.getAll("team_ids[]"), [])
  assert.deepEqual(requestUrl?.searchParams.getAll("include[]"), [
    "teams",
    "escalation_policies",
  ])
  assert.deepEqual(requestUrl?.searchParams.getAll("service_ids[]"), [])
})

test("configured services use bounded show requests instead of an account scan", async () => {
  const requestUrls: URL[] = []
  const client = createPagerDutyClient({
    beforeRequest: async () => {},
    getApiToken: () => TEST_TOKEN,
    fetch: async (input) => {
      requestUrls.push(new URL(String(input)))
      return Response.json({ service: fullService })
    },
  })

  const page = await client.fetchServicesPage(
    config({ serviceIds: ["PSVC001"] })
  )

  assert.equal(page.total, 1)
  assert.equal(page.more, false)
  assert.deepEqual(
    page.resources.map((service) => service.id),
    ["PSVC001"]
  )
  assert.equal(requestUrls.length, 1)
  assert.equal(requestUrls[0].pathname, "/services/PSVC001")
  assert.deepEqual(requestUrls[0].searchParams.getAll("include[]"), [
    "teams",
    "escalation_policies",
  ])
})

test("current on-calls use one pinned regional snapshot and complete pagination", async () => {
  const observedAt = "2026-07-02T14:00:00.000Z"
  const requestUrls: URL[] = []
  let paced = 0
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    onCall({
      escalation_policy: {
        id: index % 2 === 0 ? "PPOL001" : "PPOL002",
        summary: `Policy ${index % 2}`,
      },
      user: {
        id: `PUSR${String(index).padStart(3, "0")}`,
        summary: `User ${index}`,
      },
      ...(index === 0 ? { schedule: null, start: null, end: null } : {}),
    })
  )
  const client = createPagerDutyClient({
    beforeRequest: async () => {
      paced++
    },
    getApiToken: () => TEST_TOKEN,
    fetch: async (input) => {
      const url = new URL(String(input))
      requestUrls.push(url)
      const offset = Number(url.searchParams.get("offset"))
      return Response.json(
        offset === 0
          ? {
              oncalls: firstPage,
              offset: 0,
              limit: 100,
              total: 101,
              more: true,
            }
          : {
              // A stable duplicate may represent two indistinguishable rules.
              oncalls: [firstPage[0]],
              offset: 100,
              limit: 100,
              total: 101,
              more: false,
            }
      )
    },
  })

  const current = await client.fetchCurrentOnCalls(
    config({ region: "eu" }),
    ["PPOL002", "PPOL001", "PPOL002"],
    observedAt
  )

  assert.equal(paced, 4)
  assert.equal(current.length, 100)
  assert.equal(current[0].start, null)
  assert.equal(current[0].end, null)
  assert.equal(requestUrls.length, 4)
  assert.deepEqual(
    requestUrls.map((url) => url.origin),
    Array(4).fill("https://api.eu.pagerduty.com")
  )
  assert.deepEqual(
    requestUrls.map((url) => url.pathname),
    Array(4).fill("/oncalls")
  )
  assert.deepEqual(
    requestUrls.map((url) => url.searchParams.get("offset")),
    ["0", "100", "0", "100"]
  )
  for (const url of requestUrls) {
    assert.equal(url.searchParams.get("limit"), "100")
    assert.equal(url.searchParams.get("total"), "true")
    assert.equal(url.searchParams.get("since"), observedAt)
    assert.equal(url.searchParams.get("until"), observedAt)
    assert.deepEqual(url.searchParams.getAll("escalation_policy_ids[]"), [
      "PPOL002",
      "PPOL001",
    ])
    assert.deepEqual(url.searchParams.getAll("include[]"), [])
  }

  let onePageRequests = 0
  const onePage = createPagerDutyClient({
    beforeRequest: async () => {
      onePageRequests++
    },
    getApiToken: () => TEST_TOKEN,
    fetch: async () =>
      Response.json({
        oncalls: [onCall()],
        offset: 0,
        limit: 100,
        total: 1,
        more: false,
      }),
  })
  assert.equal(
    (await onePage.fetchCurrentOnCalls(config(), ["PPOL001"], observedAt))
      .length,
    1
  )
  assert.equal(onePageRequests, 1)

  let emptyRequests = 0
  const empty = createPagerDutyClient({
    beforeRequest: async () => {
      throw new Error("Empty policy scope must not pace an HTTP request.")
    },
    getApiToken: () => TEST_TOKEN,
    fetch: async () => {
      emptyRequests++
      throw new Error("Empty policy scope must not fetch.")
    },
  })
  assert.deepEqual(
    await empty.fetchCurrentOnCalls(config(), [], observedAt),
    []
  )
  assert.equal(emptyRequests, 0)
})

test("current on-call traversal fails closed on malformed or shifting pages", async () => {
  const observedAt = "2026-07-02T14:00:00Z"
  const malformedEntry = createPagerDutyClient({
    beforeRequest: async () => {},
    getApiToken: () => TEST_TOKEN,
    fetch: async () =>
      Response.json({
        oncalls: [onCall({ escalation_level: 0 })],
        offset: 0,
        limit: 100,
        total: 1,
        more: false,
      }),
  })
  await assert.rejects(
    () => malformedEntry.fetchCurrentOnCalls(config(), ["PPOL001"], observedAt),
    /invalid escalation_level/
  )

  const malformedPagination = createPagerDutyClient({
    beforeRequest: async () => {},
    getApiToken: () => TEST_TOKEN,
    fetch: async () =>
      Response.json({
        oncalls: [onCall()],
        offset: 0,
        limit: 100,
        total: null,
        more: false,
      }),
  })
  await assert.rejects(
    () =>
      malformedPagination.fetchCurrentOnCalls(
        config(),
        ["PPOL001"],
        observedAt
      ),
    /invalid total/
  )

  let changingPage = 0
  const changingTotal = createPagerDutyClient({
    beforeRequest: async () => {},
    getApiToken: () => TEST_TOKEN,
    fetch: async () => {
      changingPage++
      if (changingPage === 1) {
        return Response.json({
          oncalls: Array.from({ length: 100 }, (_, index) =>
            onCall({ user: { id: `PUSR${index}`, summary: `User ${index}` } })
          ),
          offset: 0,
          limit: 100,
          total: 102,
          more: true,
        })
      }
      return Response.json({
        oncalls: [
          onCall({ user: { id: "PUSR100", summary: "User 100" } }),
          onCall({ user: { id: "PUSR101", summary: "User 101" } }),
          onCall({ user: { id: "PUSR102", summary: "User 102" } }),
        ],
        offset: 100,
        limit: 100,
        total: 103,
        more: false,
      })
    },
  })
  await assert.rejects(
    () => changingTotal.fetchCurrentOnCalls(config(), ["PPOL001"], observedAt),
    /total changed during pagination \(102 to 103\)/
  )

  let confirmationCall = 0
  const shiftingIdentity = createPagerDutyClient({
    beforeRequest: async () => {},
    getApiToken: () => TEST_TOKEN,
    fetch: async (input) => {
      confirmationCall++
      const offset = Number(new URL(String(input)).searchParams.get("offset"))
      if (offset === 0) {
        return Response.json({
          oncalls: Array.from({ length: 100 }, (_, index) =>
            onCall({
              user: { id: `PUSR${index}`, summary: `User ${index}` },
            })
          ),
          offset: 0,
          limit: 100,
          total: 101,
          more: true,
        })
      }
      return Response.json({
        oncalls: [
          onCall({
            user:
              confirmationCall === 2
                ? { id: "PUSR100", summary: "User 100" }
                : { id: "PUSR999", summary: "Shifted user" },
          }),
        ],
        offset: 100,
        limit: 100,
        total: 101,
        more: false,
      })
    },
  })
  await assert.rejects(
    () =>
      shiftingIdentity.fetchCurrentOnCalls(config(), ["PPOL001"], observedAt),
    /identities changed between confirmation traversals/
  )
  assert.equal(confirmationCall, 4)

  const oversized = createPagerDutyClient({
    beforeRequest: async () => {},
    getApiToken: () => TEST_TOKEN,
    fetch: async () =>
      Response.json({
        oncalls: Array.from({ length: 100 }, (_, index) =>
          onCall({ user: { id: `PUSR${index}`, summary: `User ${index}` } })
        ),
        offset: 0,
        limit: 100,
        total: 10_001,
        more: true,
      }),
  })
  await assert.rejects(
    () => oversized.fetchCurrentOnCalls(config(), ["PPOL001"], observedAt),
    /more than 10,000 current on-call entries/
  )

  await assert.rejects(
    () => oversized.fetchCurrentOnCalls(config(), ["PPOL001"], "not-a-date"),
    /valid ISO 8601 timestamp/
  )
})

test("client fails explicitly above PagerDuty classic-pagination limits", async () => {
  const oversizedIncidents = createPagerDutyClient({
    beforeRequest: async () => {},
    getApiToken: () => TEST_TOKEN,
    fetch: async () =>
      Response.json({
        incidents: Array.from({ length: 100 }, (_, index) =>
          numberedIncident(index)
        ),
        offset: 0,
        limit: 100,
        total: 10_001,
        more: true,
      }),
  })
  await assert.rejects(
    () =>
      oversizedIncidents.fetchIncidentsPage(config({ incidentPhase: "open" }), {
        since: "2026-07-01T00:00:00.000Z",
        until: "2026-07-02T00:00:00.000Z",
      }),
    /more than 10,000 open incidents/
  )

  const oversizedServices = createPagerDutyClient({
    beforeRequest: async () => {},
    getApiToken: () => TEST_TOKEN,
    fetch: async () =>
      Response.json({
        services: Array.from({ length: 100 }, (_, index) =>
          numberedService(index)
        ),
        offset: 0,
        limit: 100,
        total: 10_001,
        more: true,
      }),
  })
  await assert.rejects(
    () => oversizedServices.fetchServicesPage(config()),
    /more than 10,000 services/
  )
})

test("rate-limit parsing honors the longest PagerDuty delay", async () => {
  const now = Date.parse("2026-07-02T12:00:00Z")
  assert.equal(parseRetryAfterSeconds("7", now), 7)
  assert.equal(parseRetryAfterSeconds("Thu, 02 Jul 2026 12:00:09 GMT", now), 9)
  assert.equal(
    rateLimitRetryAfterSeconds(
      new Headers({ "Retry-After": "7", "ratelimit-reset": "11" }),
      now
    ),
    11
  )

  const client = createPagerDutyClient({
    beforeRequest: async () => {},
    getApiToken: () => TEST_TOKEN,
    fetch: async () =>
      new Response("", {
        status: 429,
        headers: { "Retry-After": "13" },
      }),
  })
  await assert.rejects(
    () => client.fetchServicesPage(config()),
    (error: unknown) => {
      assert.ok(error instanceof RateLimitError)
      assert.equal(error.retryAfter, 13)
      return true
    }
  )
})

test("client fails closed on malformed pagination, JSON, and API errors", async () => {
  const malformed = createPagerDutyClient({
    beforeRequest: async () => {},
    getApiToken: () => TEST_TOKEN,
    fetch: async () =>
      Response.json({
        services: [fullService],
        offset: 1,
        limit: 100,
        total: null,
        more: false,
      }),
  })
  await assert.rejects(
    () => malformed.fetchServicesPage(config()),
    /invalid total/
  )

  const partialPage = createPagerDutyClient({
    beforeRequest: async () => {},
    getApiToken: () => TEST_TOKEN,
    fetch: async () =>
      Response.json({
        services: [fullService],
        offset: 0,
        limit: 100,
        total: 101,
        more: true,
      }),
  })
  await assert.rejects(
    () => partialPage.fetchServicesPage(config()),
    /partial page while more records remained/
  )

  const invalidJson = createPagerDutyClient({
    beforeRequest: async () => {},
    getApiToken: () => TEST_TOKEN,
    fetch: async () => new Response("not json", { status: 200 }),
  })
  await assert.rejects(
    () => invalidJson.fetchServicesPage(config()),
    /invalid JSON/
  )

  const apiError = createPagerDutyClient({
    beforeRequest: async () => {},
    getApiToken: () => TEST_TOKEN,
    fetch: async () => new Response(`bad token ${TEST_TOKEN}`, { status: 403 }),
  })
  await assert.rejects(
    () => apiError.fetchServicesPage(config()),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.doesNotMatch(error.message, new RegExp(TEST_TOKEN))
      assert.match(error.message, /Unexpected non-JSON error response/)
      return true
    }
  )
})

test("execute functions wire client, state, and transforms end to end", async () => {
  let incidentRequest = 0
  let serviceRequests = 0
  let onCallRequests = 0
  const client: PagerDutyClient = {
    async fetchIncidentsPage(scope) {
      incidentRequest++
      if (incidentRequest <= 2) {
        assert.equal(
          scope.incidentPhase,
          incidentRequest === 1 ? "open" : "openConfirm"
        )
        return incidentPage([fullIncident])
      }

      assert.equal(scope.incidentPhase, "recent")
      return incidentPage([fullIncident])
    },
    async fetchServicesPage(scope, offset) {
      serviceRequests++
      assert.equal(scope.region, "us")
      assert.equal(offset, 0)
      return servicePage([fullService])
    },
    async fetchCurrentOnCalls(scope, escalationPolicyIds, observedAt) {
      onCallRequests++
      assert.equal(scope.region, "us")
      assert.deepEqual(escalationPolicyIds, ["PPOL001"])
      assert.equal(observedAt, "2026-07-02T14:00:00.000Z")
      return [onCall()]
    },
  }

  const openBatch = await executeIncidents(undefined, client, () =>
    config({ incidentLookbackDays: 1 })
  )
  assert.equal(openBatch.hasMore, true)
  assert.equal(openBatch.changes[0]?.key, "PINC001")
  assert.equal(openBatch.nextState.phase, "openConfirm")

  const confirmBatch = await executeIncidents(
    openBatch.nextState,
    client,
    () => {
      throw new Error("Pinned state should not re-read configuration.")
    }
  )
  assert.equal(confirmBatch.hasMore, true)
  assert.deepEqual(confirmBatch.changes, [])
  assert.equal(confirmBatch.nextState.phase, "recent")

  const recentBatch = await executeIncidents(
    confirmBatch.nextState,
    client,
    () => {
      throw new Error("Pinned state should not re-read configuration.")
    }
  )
  assert.equal(recentBatch.hasMore, false)
  assert.equal(recentBatch.changes[0].key, "PINC001")

  const serviceState = initialServiceSyncState(config(), "2026-07-02T14:00:00Z")
  const serviceDiscovery = await executeServices(serviceState, client, () => {
    throw new Error("Pinned state should not re-read configuration.")
  })
  assert.equal(serviceDiscovery.hasMore, true)
  assert.deepEqual(serviceDiscovery.changes, [])
  assert.equal(serviceDiscovery.nextState.phase, "publish")
  assert.equal(onCallRequests, 0)

  const serviceBatch = await executeServices(
    serviceDiscovery.nextState,
    client,
    () => {
      throw new Error("Pinned state should not re-read configuration.")
    }
  )
  assert.equal(serviceBatch.hasMore, false)
  assert.equal(serviceRequests, 2)
  assert.equal(onCallRequests, 1)
  assert.equal(serviceBatch.changes[0].key, "PSVC001")
  assert.equal(
    serviceBatch.changes[0].upstreamUpdatedAt,
    "2026-07-02T14:00:00.000Z"
  )
  assertPropertyContains(
    serviceBatch.changes[0].properties["Primary Coverage"],
    "Covered"
  )
  assertPropertyContains(
    serviceBatch.changes[0].properties["Primary On Call"],
    "Ada Lovelace"
  )
})

test("incident state traverses open incidents before pinned recent windows", () => {
  const initial = initialIncidentSyncState(
    config({
      incidentLookbackDays: 14,
      serviceIds: ["PSVC001"],
      teamIds: ["PTEAM01"],
    }),
    "2026-07-02T12:00:00Z"
  )
  assert.equal(initial.cycleSince, "2026-06-18T12:00:00.000Z")
  assert.equal(initial.cycleUntil, "2026-07-02T12:00:00.000Z")
  assert.equal(initial.windowUntil, "2026-06-25T12:00:00.000Z")
  assert.equal(initial.phase, "open")
  assert.deepEqual(initial.scope.serviceIds, ["PSVC001"])

  const first = nextIncidentSyncState(
    initial,
    incidentPage(
      [
        { ...fullIncident, incident_number: 10 },
        { ...minimalIncident, incident_number: 11 },
      ],
      {
        limit: 2,
        total: 3,
        more: true,
        nextOffset: 2,
      }
    )
  )
  assert.ok(first)
  assert.equal(first.offset, 1)
  assert.equal(first.expectedTotal, 3)
  assert.equal(first.lastIncidentId, "PINC002")
  assert.equal(first.lastIncidentNumber, 11)

  const confirmation = nextIncidentSyncState(
    first,
    incidentPage(
      [
        { ...minimalIncident, incident_number: 11 },
        { ...fullIncident, id: "PINC003", incident_number: 12 },
      ],
      {
        offset: 1,
        limit: 2,
        total: 3,
      }
    )
  )
  assert.ok(confirmation)
  assert.equal(confirmation.phase, "openConfirm")
  assert.deepEqual(confirmation.openIncidentIds, [
    "PINC001",
    "PINC002",
    "PINC003",
  ])

  const confirmationFirst = nextIncidentSyncState(
    confirmation,
    incidentPage(
      [
        { ...fullIncident, incident_number: 10 },
        { ...minimalIncident, incident_number: 11 },
      ],
      {
        limit: 2,
        total: 3,
        more: true,
        nextOffset: 2,
      }
    )
  )
  assert.ok(confirmationFirst)

  const recent = nextIncidentSyncState(
    confirmationFirst,
    incidentPage(
      [
        { ...minimalIncident, incident_number: 11 },
        { ...fullIncident, id: "PINC003", incident_number: 12 },
      ],
      {
        offset: 1,
        limit: 2,
        total: 3,
      }
    )
  )
  assert.ok(recent)
  assert.equal(recent.phase, "recent")
  assert.equal(recent.windowSince, initial.cycleSince)
  assert.equal(recent.windowUntil, initial.windowUntil)
  assert.equal(recent.offset, 0)
  assert.equal(recent.expectedTotal, undefined)

  const nextWindow = nextIncidentSyncState(
    recent,
    incidentPage([], { total: 0 })
  )
  assert.ok(nextWindow)
  assert.equal(nextWindow.windowSince, initial.windowUntil)
  assert.equal(nextWindow.windowUntil, initial.cycleUntil)
  assert.equal(nextWindow.offset, 0)
  assert.equal(nextWindow.expectedTotal, undefined)

  const oneDayInitial = initialIncidentSyncState(
    config({ incidentLookbackDays: 1 }),
    "2026-07-02T12:00:00Z"
  )
  const oneDayRecent = nextIncidentSyncState(
    oneDayInitial,
    incidentPage([], { total: 0 })
  )
  assert.ok(oneDayRecent)
  assert.equal(oneDayRecent.phase, "openConfirm")
  const oneDayHistory = nextIncidentSyncState(
    oneDayRecent,
    incidentPage([], { total: 0 })
  )
  assert.ok(oneDayHistory)
  assert.equal(oneDayHistory.phase, "recent")
  assert.equal(
    nextIncidentSyncState(oneDayHistory, incidentPage([], { total: 0 })),
    undefined
  )
})

test("oversized recent windows bisect and retain their pending boundary", () => {
  const initial = initialIncidentSyncState(
    config({ incidentLookbackDays: 7 }),
    "2026-07-02T12:00:00Z"
  )
  const confirmation = nextIncidentSyncState(
    initial,
    incidentPage([], { total: 0 })
  )
  assert.ok(confirmation)
  const recent = nextIncidentSyncState(
    confirmation,
    incidentPage([], { total: 0 })
  )
  assert.ok(recent)

  const split = nextIncidentSyncState(
    recent,
    incidentPage([], {
      total: 10_001,
      more: true,
      nextOffset: 100,
      requiresWindowSplit: true,
    })
  )
  assert.ok(split)
  assert.equal(split.windowSince, recent.windowSince)
  assert.ok(Date.parse(split.windowUntil) < Date.parse(recent.windowUntil))
  assert.deepEqual(split.pendingWindowUntils, [recent.windowUntil])

  const rightHalf = nextIncidentSyncState(split, incidentPage([], { total: 0 }))
  assert.ok(rightHalf)
  assert.equal(rightHalf.windowSince, split.windowUntil)
  assert.equal(rightHalf.windowUntil, recent.windowUntil)
  assert.deepEqual(rightHalf.pendingWindowUntils, [])
})

test("open confirmation rejects equal-count identity substitutions", () => {
  const initial = initialIncidentSyncState(
    config({ incidentLookbackDays: 1 }),
    "2026-07-02T12:00:00Z"
  )
  const confirmation = nextIncidentSyncState(
    initial,
    incidentPage([fullIncident])
  )
  assert.ok(confirmation)
  assert.equal(confirmation.phase, "openConfirm")

  assert.throws(
    () => nextIncidentSyncState(confirmation, incidentPage([minimalIncident])),
    /identities changed between confirmation passes/
  )
})

test("incident state rejects reordering, changing totals, and stalled offsets", () => {
  const initial = initialIncidentSyncState(
    config({ incidentLookbackDays: 1 }),
    "2026-07-02T12:00:00Z"
  )
  const first = nextIncidentSyncState(
    initial,
    incidentPage(
      [
        { ...fullIncident, incident_number: 20 },
        { ...minimalIncident, incident_number: 21 },
      ],
      {
        limit: 2,
        total: 3,
        more: true,
        nextOffset: 2,
      }
    )
  )
  assert.ok(first)

  assert.throws(
    () =>
      nextIncidentSyncState(
        first,
        incidentPage(
          [
            { ...minimalIncident, incident_number: 21 },
            { ...fullIncident, id: "PINC003", incident_number: 19 },
          ],
          {
            offset: 1,
            limit: 2,
            total: 3,
          }
        )
      ),
    /not strictly ordered/
  )
  assert.throws(
    () =>
      nextIncidentSyncState(
        first,
        incidentPage(
          [
            { ...fullIncident, incident_number: 20 },
            { ...minimalIncident, incident_number: 22 },
          ],
          { offset: 1, limit: 2, total: 3 }
        )
      ),
    /membership shifted across the page boundary/
  )
  assert.throws(
    () =>
      nextIncidentSyncState(
        first,
        incidentPage(
          [
            { ...minimalIncident, incident_number: 21 },
            { ...fullIncident, id: "PINC003", incident_number: 22 },
          ],
          { offset: 1, limit: 2, total: 4 }
        )
      ),
    /total changed/
  )
  assert.throws(
    () =>
      nextIncidentSyncState(
        initial,
        incidentPage(
          [
            { ...fullIncident, incident_number: 20 },
            { ...minimalIncident, incident_number: 21 },
          ],
          {
            limit: 2,
            total: 3,
            more: true,
            nextOffset: 1,
          }
        )
      ),
    /too small for boundary overlap/
  )
})

test("configured service state publishes directly and rejects duplicates", () => {
  const initial = initialServiceSyncState(
    config({ serviceIds: ["PSVC001", "PSVC002"] }),
    "2026-07-02T12:00:00Z"
  )
  assert.equal(initial.observedAt, "2026-07-02T12:00:00.000Z")
  assert.equal(initial.phase, "publish")
  assert.deepEqual(initial.scope.serviceIds, ["PSVC001", "PSVC002"])
  assert.deepEqual(initial.expectedServiceIds, ["PSVC001", "PSVC002"])

  const first = nextServiceSyncState(
    initial,
    servicePage([fullService], {
      limit: 1,
      total: 2,
      more: true,
      nextOffset: 1,
    })
  )
  assert.ok(first)
  assert.deepEqual(first.seenServiceIds, ["PSVC001"])

  assert.equal(
    nextServiceSyncState(
      first,
      servicePage([minimalService], {
        offset: 1,
        limit: 1,
        total: 2,
      })
    ),
    undefined
  )
  assert.throws(
    () =>
      nextServiceSyncState(
        first,
        servicePage([fullService], {
          offset: 1,
          limit: 1,
          total: 2,
        })
      ),
    /repeated service PSVC001/
  )
  assert.throws(
    () =>
      nextServiceSyncState(
        first,
        servicePage([minimalService], {
          offset: 1,
          limit: 1,
          total: 3,
        })
      ),
    /total changed/
  )
})

test("unscoped service discovery requires the same complete publish set", () => {
  const initial = initialServiceSyncState(config(), "2026-07-02T12:00:00Z")
  assert.equal(initial.phase, "discover")
  assert.deepEqual(initial.expectedServiceIds, [])

  const publish = nextServiceSyncState(
    initial,
    servicePage([fullService, minimalService], { total: 2 })
  )
  assert.ok(publish)
  assert.equal(publish.phase, "publish")
  assert.equal(publish.offset, 0)
  assert.equal(publish.expectedTotal, undefined)
  assert.deepEqual(publish.seenServiceIds, [])
  assert.deepEqual(publish.expectedServiceIds, ["PSVC001", "PSVC002"])

  // Membership is set-based: a harmless name-order change still converges.
  assert.equal(
    nextServiceSyncState(
      publish,
      servicePage([minimalService, fullService], { total: 2 })
    ),
    undefined
  )

  assert.throws(
    () =>
      nextServiceSyncState(
        publish,
        servicePage(
          [
            fullService,
            { ...minimalService, id: "PSVC003", name: "New service" },
          ],
          { total: 2 }
        )
      ),
    /PSVC003 appeared after service discovery/
  )
  assert.throws(
    () =>
      nextServiceSyncState(publish, servicePage([fullService], { total: 1 })),
    /membership changed between discovery and publish \(2 to 1\)/
  )
})

test("empty service discovery publishes one confirmed empty snapshot", () => {
  const initial = initialServiceSyncState(config(), "2026-07-02T12:00:00Z")
  const publish = nextServiceSyncState(initial, servicePage([]))
  assert.ok(publish)
  assert.equal(publish.phase, "publish")
  assert.deepEqual(publish.expectedServiceIds, [])
  assert.equal(nextServiceSyncState(publish, servicePage([])), undefined)
})

test("service publish rejects a late equal-count substitution across pages", () => {
  const initial = initialServiceSyncState(config(), "2026-07-02T12:00:00Z")
  const discoveryPageTwo = nextServiceSyncState(
    initial,
    servicePage([fullService, minimalService], {
      limit: 2,
      total: 3,
      more: true,
      nextOffset: 2,
    })
  )
  assert.ok(discoveryPageTwo)
  const thirdService = {
    ...minimalService,
    id: "PSVC003",
    name: "Third service",
  }
  const publish = nextServiceSyncState(
    discoveryPageTwo,
    servicePage([thirdService], { offset: 2, limit: 2, total: 3 })
  )
  assert.ok(publish)
  assert.equal(publish.phase, "publish")

  const publishPageTwo = nextServiceSyncState(
    publish,
    servicePage([fullService, minimalService], {
      limit: 2,
      total: 3,
      more: true,
      nextOffset: 2,
    })
  )
  assert.ok(publishPageTwo)
  assert.throws(
    () =>
      nextServiceSyncState(
        publishPageTwo,
        servicePage(
          [{ ...thirdService, id: "PSVC004", name: "Replacement service" }],
          { offset: 2, limit: 2, total: 3 }
        )
      ),
    /PSVC004 appeared after service discovery/
  )
})
