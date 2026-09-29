# Meeting Prep

> [!WARNING]
> Notion Apps and the Apps SDK are early alpha features and can introduce
> breaking changes.

A Notion App that turns Google Calendar meetings with outside attendees into
Notion pages with a short research brief.

## What it creates

| Kind         | Name               | Purpose                                                                     |
| ------------ | ------------------ | --------------------------------------------------------------------------- |
| Page         | APP.md             | Home page with the next-meeting card, upcoming meetings, and usage guidance |
| Database     | Meetings           | One row per external meeting; brief at the top of the page, notes below     |
| Database     | People             | One row per outside attendee, keyed by email                                |
| Database     | Companies          | One row per outside company, keyed by email domain                          |
| Database     | Workflow runs      | One row per calendar ingest run; add a row to run a catch-up now            |
| Custom agent | Meeting researcher | Web research plus email summary, returned as JSON                           |
| Custom view  | Next meeting       | Company and people cards for the next meeting, plus a Today calendar view   |

## Workflows

- `calendarIngest`: calendar event created, updated, or cancelled, plus an
  hourly backfill. Upserts Meetings by event ID, People by email, and
  Companies by domain. On first run it adds the two-way relations
  (Attendees, Companies, Company), which the SDK cannot declare yet. Each run
  is logged in Workflow runs as Pending, then Success or Failed; adding a row there
  runs a catch-up. A run that crashes or times out stays Pending, because the
  SDK has no hook for that yet.
- `meetingPrep`: a Meetings row is created, its attendees change, or
  **Regenerate prep** is ticked. Searches Gmail (last 90 days, 10 threads per
  attendee), calls the researcher agent, and rewrites the **Meeting prep**
  section. Anything under **Notes** is left alone.
- `morningPrep`: every day at 07:45 in `TIME_ZONE`, it refreshes the prep for
  that day's meetings.

"External" means an attendee's email domain is not your account's domain or
one of its coworker domains. Consumer mailboxes such as gmail.com get a People
row but no Company row.

## Configure

Set `TIME_ZONE` in `src/lib/config.ts` (default `America/Los_Angeles`). The
same file sets the backfill window (1 day back, 7 days ahead) and the email
lookback limits.

## Develop

```shell
pnpm install
npm run check
npm test
npm run build
```

The App's name is the title of its home page. Set it on the first deploy:

```shell
ntn apps deploy --name "Perfect Meetings App"
```

## Run on demand and debug

Every workflow has a manual trigger. Run it with `ntn workers exec` and read
the result with `ntn workers runs list` and `ntn workers runs logs <run-id>`.
You can also run the manual trigger from the workflow in Notion. For a calendar
catch-up, add a row to **Workflow runs**, or run **Calendar ingest** with mode
**backfill**, leaving the other inputs empty. To refresh today's briefs, run **Morning prep** with an empty
date. Wait for the catch-up to finish before refreshing briefs for new meetings.

```shell
# Ingest only your current or next meeting. includeInternal counts coworkers
# as outside attendees for this run only, so you can test with internal meetings.
ntn workers exec calendarIngest -d '{"mode":"next","eventStartTime":null,"eventId":null,"includeInternal":true}'

# Other ingest modes: "backfill" (the hourly scan), "event" (needs
# eventStartTime), and "cancel" (needs eventId).
ntn workers exec calendarIngest -d '{"mode":"backfill","eventStartTime":null,"eventId":null,"includeInternal":null}'

# Rewrite one meeting's brief. reason: "created", "updated", or null (force).
ntn workers exec meetingPrep -d '{"meeting":"<Meetings page URL or ID>","reason":null}'

# Run the morning refresh for today, or for another date (YYYY-MM-DD).
ntn workers exec morningPrep -d '{"date":null}'
```

The "List calendar events" step in each ingest run records a diagnostic
summary: events per calendar, why events were skipped, and a tally of attendee
domains. When a run finds no meetings, check it first.

To treat coworkers as outside attendees on every trigger, not just one manual
run, set `INCLUDE_INTERNAL_ATTENDEES` on your own worker:

```shell
ntn workers env set INCLUDE_INTERNAL_ATTENDEES=true
ntn workers env unset INCLUDE_INTERNAL_ATTENDEES
```

This applies only to the worker you set it on. Each new meeting it lets
through starts a research session, so turning it on for a busy calendar uses
AI credits quickly. Rows it creates remain after you unset it.

Notes:

- New page watches and schedules take effect after you open the workflow in
  Notion and save it.
- Each 15-second research poll resumes as a new run, so one prep appears as
  several entries in `runs list`.
