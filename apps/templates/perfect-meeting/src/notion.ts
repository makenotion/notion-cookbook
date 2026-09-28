import { customAgent, database } from "@notionhq/apps"
import { notion } from "@notionhq/apps/notion-as-code"

// Resource and property IDs are stable declaration identities. Do not rename
// them after deploying; renaming creates new resources. The home page is
// APP.md, which the build provisions and which links to these databases.
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
    Name: { resourceId: "person-name", type: "title" },
    Email: { resourceId: "person-email", type: "email" },
    Role: { resourceId: "person-role", type: "text" },
    // Where the researcher found the role, for checking.
    "Role source": { resourceId: "person-role-source", type: "url" },
    // Join key to Companies.Domain; empty for personal mailboxes.
    "Company domain": { resourceId: "person-company-domain", type: "text" },
    Photo: { resourceId: "person-photo", type: "url" },
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
    Title: { resourceId: "meeting-title", type: "title" },
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
    "Regenerate prep": { resourceId: "meeting-regenerate", type: "checkbox" },
    Agenda: { resourceId: "meeting-agenda", type: "text" },
    "Calendar link": { resourceId: "meeting-calendar-url", type: "url" },
    "Video link": { resourceId: "meeting-video-url", type: "url" },
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

// Adding a row here runs the calendar ingest and morning prep immediately,
// without waiting for their schedules.
export const runNow = database("run-now-db", {
  dataSourceResourceId: "run-now-source",
  name: "Run now",
  icon: { type: "emoji", emoji: "▶️" },
  schema: {
    Name: { resourceId: "run-now-name", type: "title" },
  },
})

export const researcher = customAgent({
  resourceId: "meeting-researcher",
  name: "Meeting researcher",
  icon: { type: "emoji", emoji: "🔎" },
  webAccess: true,
  instructions: `You write concise pre-meeting briefs. Each request gives you a meeting (title, time, agenda text), its outside attendees (name, email, company), and one-line summaries of recent email threads with them.

Research every attendee, not just a few: run at least one web search per attendee using their full name plus their company name, for example "Jane Doe Acme LinkedIn". Search result titles and snippets count as evidence even when the page itself (such as a LinkedIn profile) cannot be opened; a snippet like "Jane Doe - Engineering Lead - Acme" is enough for a role. When the name is marked unknown, search the email address and company instead. Also search what each company does.

Base the email summary only on the supplied thread summaries and never invent correspondence. If there are none, say that there is no recent email history.

Reply with only one JSON object and no other text:
{
  "company": "One paragraph (3-4 sentences max) on what the company or companies do, their market and anything notable and recent.",
  "role": "One paragraph (3-4 sentences max) on each attendee's role and responsibilities and what they likely care about.",
  "emails": "One paragraph (3-4 sentences max) summarising recent email interactions: topics, commitments, open questions.",
  "objective": "One paragraph (3-4 sentences max) on the likely objective of the meeting and a suggested agenda.",
  "people": [{ "email": "attendee email", "name": "Full name, e.g. Jane Doe", "role": "Short job title, e.g. VP Engineering", "roleSource": "URL of the page or search result the role came from" }],
  "companies": [{ "domain": "example.com", "name": "Proper company name", "summary": "One sentence on what the company does." }]
}

Include every attendee in "people". Give a full name only when you are confident it belongs to that email address, and use an empty string otherwise. Use an empty string for an unknown role and its roleSource. In "companies", use each domain exactly as it appears in the attendee list, and omit a company you could not identify.`,
})
