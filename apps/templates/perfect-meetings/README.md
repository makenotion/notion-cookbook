# Meeting Prep

> [!WARNING]
> Notion Apps and the Apps SDK are early alpha features and can introduce
> breaking changes.

A Notion App that turns Google Calendar meetings with outside attendees into
Notion pages with a short research brief.

## What it creates

| Kind         | Name               | Purpose                                                                 |
| ------------ | ------------------ | ----------------------------------------------------------------------- |
| Page         | APP.md             | Home page from `APP.md`; explains the App and links to every database   |
| Database     | Meetings           | One row per external meeting; brief at the top of the page, notes below |
| Database     | People             | One row per outside attendee, keyed by email                            |
| Database     | Companies          | One row per outside company, keyed by email domain                      |
| Database     | Run now            | Add a row to run the ingest and morning prep immediately                |
| Custom agent | Meeting researcher | Web research plus email summary, returned as JSON                       |
| Custom view  | Next meeting       | Meetings view showing a prep card for the current or next meeting       |

## Workflows

- `calendarIngest`: calendar event created, updated, or cancelled, plus an
  hourly backfill. Upserts Meetings by event ID, People by email, and
  Companies by domain. On first run it adds the two-way relations
  (Attendees, Companies, Company), which the SDK cannot declare yet.
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

## Debugging

Every workflow has a manual trigger. Run it with `ntn workers exec` and read
the result with `ntn workers runs list` and `ntn workers runs logs <run-id>`.

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
