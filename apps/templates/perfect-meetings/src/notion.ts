import { customAgent, database } from "@notionhq/apps"
import { notion } from "@notionhq/apps/notion-as-code"

// Resource and property IDs are stable declaration identities. Do not rename
// them after deploying; renaming creates new resources. The home page is
// APP.md, which the build provisions and which embeds or links to these
// databases.
//
// Apps SDK 0.0.41 rejects relation properties in declarations, so the
// databases join on text keys (Attendee emails, Company domain, Domain) and
// the ingest workflow adds the two-way relations at runtime. See
// src/workflows/lib/relations.ts.
const MEETINGS_SOURCE = "meetings-source"
const PEOPLE_SOURCE = "people-source"
const COMPANIES_SOURCE = "companies-source"

export const PREP_STATUS = {
  queued: "Queued",
  researching: "Researching",
  ready: "Ready",
  failed: "Failed",
} as const

// How sure the researcher is that the name and role it found belong to this
// person. Empty until research finds a match.
export const CONFIDENCE = {
  high: "High",
  low: "Low",
} as const

export const MEETING_STATUS = {
  scheduled: "Scheduled",
  cancelled: "Cancelled",
} as const

export const companies = database("companies-db", {
  dataSourceResourceId: COMPANIES_SOURCE,
  name: "Companies",
  icon: { type: "emoji", emoji: "🏢" },
  schema: {
    Name: { resourceId: "company-name", type: "title" },
    Domain: { resourceId: "company-domain", type: "text" },
    Website: { resourceId: "company-website", type: "url" },
    Summary: { resourceId: "company-summary", type: "text" },
  },
  views: [
    {
      resourceId: "companies-all",
      name: "All companies",
      type: "table",
      dataSourceResourceId: COMPANIES_SOURCE,
      sorts: [{ propertyId: "company-name", direction: "ascending" }],
    },
  ],
})

export const people = database("people-db", {
  dataSourceResourceId: PEOPLE_SOURCE,
  name: "People",
  icon: { type: "emoji", emoji: "🧑‍💼" },
  schema: {
    Name: {
      resourceId: "person-name",
      type: "title",
      description:
        "Each brief updates the Profile at the top of this page. Write your own Notes below it; refreshes leave them untouched.",
    },
    Email: { resourceId: "person-email", type: "email" },
    Role: { resourceId: "person-role", type: "text" },
    // Where the researcher found the role, for checking.
    "Role source": { resourceId: "person-role-source", type: "url" },
    // Join key to Companies.Domain; empty for personal mailboxes.
    "Company domain": { resourceId: "person-company-domain", type: "text" },
    Photo: { resourceId: "person-photo", type: "url" },
    // Public profiles. The researcher fills in only the ones that are empty.
    LinkedIn: {
      resourceId: "person-linkedin",
      type: "url",
      description:
        "Filled in by research only when empty. Replace a wrong one yourself.",
    },
    X: {
      resourceId: "person-x",
      type: "url",
      description:
        "Filled in by research only when empty. Replace a wrong one yourself.",
    },
    Instagram: {
      resourceId: "person-instagram",
      type: "url",
      description:
        "Filled in by research only when empty. Replace a wrong one yourself.",
    },
    "Personal site": {
      resourceId: "person-site",
      type: "url",
      description:
        "Filled in by research only when empty. Replace a wrong one yourself.",
    },
    // Low means the match was partial (such as a first name at the right
    // company) and may be replaced by a later match. Set it to High to keep
    // a name and role.
    Confidence: {
      resourceId: "person-confidence",
      type: "select",
      description:
        "How sure research is of this name and role. Low is a partial match that a later brief may correct; set High once you have checked it to keep it.",
      options: [
        { name: CONFIDENCE.high, color: "green" },
        { name: CONFIDENCE.low, color: "orange" },
      ],
    },
  },
  views: [
    {
      resourceId: "people-all",
      name: "All people",
      type: "table",
      dataSourceResourceId: PEOPLE_SOURCE,
      sorts: [{ propertyId: "person-name", direction: "ascending" }],
    },
  ],
})

export const meetings = database("meetings-db", {
  dataSourceResourceId: MEETINGS_SOURCE,
  name: "Meetings",
  icon: { type: "emoji", emoji: "🗓️" },
  schema: {
    Title: {
      resourceId: "meeting-title",
      type: "title",
      description:
        "The Meeting prep brief is at the top of the page. Write your own Notes below it; refreshes leave them untouched.",
    },
    When: { resourceId: "meeting-when", type: "date" },
    Status: {
      resourceId: "meeting-status",
      type: "select",
      options: [
        { name: MEETING_STATUS.scheduled, color: "green" },
        { name: MEETING_STATUS.cancelled, color: "gray" },
      ],
    },
    "Prep status": {
      resourceId: "meeting-prep-status",
      type: "select",
      options: [
        { name: PREP_STATUS.queued, color: "default" },
        { name: PREP_STATUS.researching, color: "yellow" },
        { name: PREP_STATUS.ready, color: "green" },
        { name: PREP_STATUS.failed, color: "red" },
      ],
    },
    "Prep updated": { resourceId: "meeting-prep-updated", type: "date" },
    "Regenerate prep": {
      resourceId: "meeting-regenerate",
      type: "checkbox",
      description:
        "Tick to write a fresh brief or retry a failed one. Your notes are left untouched.",
    },
    Agenda: { resourceId: "meeting-agenda", type: "text" },
    "Calendar link": {
      resourceId: "meeting-calendar-url",
      type: "url",
      description:
        "Copied from the calendar event and updated when the event changes.",
    },
    "Video link": {
      resourceId: "meeting-video-url",
      type: "url",
      description:
        "Copied from the calendar event and updated when the event changes.",
    },
    "Event ID": { resourceId: "meeting-event-id", type: "text" },
    // Sorted, comma-separated outside attendee emails: the join key to People.
    // Ingest writes it only when the set changes, so prep watches it.
    "Attendee emails": { resourceId: "meeting-attendee-emails", type: "text" },
    // The attendee set the current brief was written for.
    "Prepped for": { resourceId: "meeting-prepped-for", type: "text" },
  },
  views: [
    {
      resourceId: "meetings-upcoming",
      name: "Upcoming",
      type: "table",
      dataSourceResourceId: MEETINGS_SOURCE,
      filters: [
        {
          type: "property",
          propertyId: "meeting-when",
          propertyType: "date",
          operator: "date_is_on_or_after",
          value: { type: "relative", value: "today" },
        },
      ],
      sorts: [{ propertyId: "meeting-when", direction: "ascending" }],
      properties: [
        { property: "meeting-when", visible: true },
        { property: "meeting-attendee-emails", visible: true },
        { property: "meeting-prep-status", visible: true },
        { property: "meeting-regenerate", visible: true },
        { property: "meeting-status", visible: true },
        { property: "meeting-agenda", visible: false },
        { property: "meeting-calendar-url", visible: false },
        { property: "meeting-video-url", visible: false },
        { property: "meeting-event-id", visible: false },
        { property: "meeting-prepped-for", visible: false },
        { property: "meeting-prep-updated", visible: false },
      ],
    },
    {
      resourceId: "meetings-calendar",
      name: "Calendar",
      type: "calendar",
      dataSourceResourceId: MEETINGS_SOURCE,
      calendarBy: "meeting-when",
    },
    {
      resourceId: "meetings-all",
      name: "All meetings",
      type: "table",
      dataSourceResourceId: MEETINGS_SOURCE,
      sorts: [{ propertyId: "meeting-when", direction: "descending" }],
    },
  ],
})

export const RUN_STATUS = {
  pending: "Pending",
  success: "Success",
  failed: "Failed",
} as const

export const RUN_TRIGGER = {
  runNow: "Run now",
  calendar: "Calendar event",
  hourly: "Hourly",
  manual: "Manual",
} as const

// One row per calendar ingest run. Adding a row yourself runs a calendar
// catch-up, and the ingest fills in that row.
export const syncRuns = database("sync-runs-db", {
  dataSourceResourceId: "sync-runs-source",
  name: "Workflow runs",
  icon: { type: "emoji", emoji: "🔄" },
  schema: {
    Name: { resourceId: "run-name", type: "title" },
    Started: { resourceId: "run-started", type: "date" },
    Finished: { resourceId: "run-finished", type: "date" },
    Status: {
      resourceId: "run-status",
      type: "select",
      options: [
        { name: RUN_STATUS.pending, color: "yellow" },
        { name: RUN_STATUS.success, color: "green" },
        { name: RUN_STATUS.failed, color: "red" },
      ],
    },
    // Empty or "Run now" marks a row a person added; workflows use the rest.
    Trigger: {
      resourceId: "run-trigger",
      type: "select",
      options: [
        { name: RUN_TRIGGER.runNow, color: "blue" },
        { name: RUN_TRIGGER.calendar, color: "purple" },
        { name: RUN_TRIGGER.hourly, color: "gray" },
        { name: RUN_TRIGGER.manual, color: "orange" },
      ],
    },
    Error: { resourceId: "run-error", type: "text" },
    // For `ntn workers runs logs <run-id>`.
    "Run ID": { resourceId: "run-id", type: "text" },
  },
  views: [
    {
      resourceId: "sync-runs-recent",
      name: "Recent runs",
      type: "table",
      dataSourceResourceId: "sync-runs-source",
      sorts: [{ propertyId: "run-started", direction: "descending" }],
      properties: [
        { property: "run-started", visible: true },
        { property: "run-finished", visible: true },
        { property: "run-status", visible: true },
        { property: "run-trigger", visible: true },
        { property: "run-error", visible: true },
        { property: "run-id", visible: false },
      ],
    },
  ],
})

export const researcher = customAgent({
  resourceId: "meeting-researcher",
  name: "Meeting researcher",
  icon: { type: "emoji", emoji: "🔎" },
  webAccess: true,
  instructions: `You write concise pre-meeting briefs and short profiles of the people in them. Each request gives you a meeting (title, time, agenda text), its outside attendees (name, email, company, and past meetings with them), and one-line summaries of recent email threads with them.

Research every attendee, not just a few: run at least one web search per attendee using their full name plus their company name, for example "Jane Doe Acme LinkedIn". Search result titles and snippets count as evidence even when the page itself (such as a LinkedIn, ZoomInfo, or RocketReach profile) cannot be opened; a snippet like "Jane Doe - Engineering Lead - Acme" is enough for a role. Also search what each company does.

When an attendee's full name is unknown, their email handle is usually a first name, a first initial and surname, or both. Try these searches in order, stopping once you find them, and run at least two before giving up: the handle as a name plus the company name and "LinkedIn" (for example "Demarcus Mintlify LinkedIn"); the handle plus the company name without "LinkedIn", which also finds ZoomInfo and RocketReach pages; then the full email address in quotes.

Mark a person "high" confidence when the evidence ties their full name, or their email address, to the company. When the only match is on part of the name, such as a first name that matches the handle at the right company, still report that person, but mark them "low" confidence. An attendee listed with an unconfirmed name or a low-confidence role was matched that way before: check it again and mark it "high" only if you now find stronger evidence.

For each attendee you identify, also find their public profiles: LinkedIn, X (Twitter), Instagram, and a personal website. An attendee line lists any profiles already known; do not search for those again. The email handle is often also their X or Instagram handle, so try it, for example "wustep site:x.com". Report a profile only when its name, photo caption, bio, or linked site ties it to this person and company.

Base the email summaries only on the supplied thread summaries, and the meeting history only on the supplied past meetings; never invent correspondence or meetings. If there are none, say that there is no recent email or meeting history.

Reply with only one JSON object and no other text:
{
  "company": "One paragraph (3-4 sentences max) on what the company or companies do, their market and anything notable and recent.",
  "role": "One paragraph (3-4 sentences max) on each attendee's role and responsibilities and what they likely care about.",
  "emails": "One paragraph (3-4 sentences max) summarising recent email interactions: topics, commitments, open questions.",
  "objective": "One paragraph (3-4 sentences max) on the likely objective of the meeting and a suggested agenda.",
  "people": [{ "email": "attendee email", "name": "Full name, e.g. Jane Doe", "role": "Short job title, e.g. VP Engineering", "roleSource": "URL of the page or search result the role came from", "confidence": "high or low", "responsibilities": "2-3 sentences on what this person is responsible for and what they likely care about", "interactions": "2-3 sentences summarising recent meetings and email with this person: topics, commitments, open questions", "profiles": { "linkedin": "profile URL", "x": "profile URL", "instagram": "profile URL", "website": "personal site URL" } }],
  "companies": [{ "domain": "example.com", "name": "Proper company name", "summary": "One sentence on what the company does." }]
}

Include every attendee in "people". Give a full name when it is a high- or low-confidence match as described above, and use an empty string when you found no match. Use an empty string for an unknown role and its roleSource, and for responsibilities you could not find. In "profiles", include only profiles you found, and leave out ones already known. In "companies", use each domain exactly as it appears in the attendee list, and omit a company you could not identify.`,
})
