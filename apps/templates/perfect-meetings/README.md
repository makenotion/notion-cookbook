# Meeting Prep

> [!WARNING]
> Notion Apps and the Apps SDK are early alpha features and can introduce
> breaking changes.

A Notion App that turns Google Calendar meetings with outside attendees into
Notion pages with a short research brief.

## What it creates

| Kind         | Name               | Purpose                                                                                    |
| ------------ | ------------------ | ------------------------------------------------------------------------------------------ |
| Page         | APP.md             | Home page with the main UI block and a Debug Data toggle linking the databases             |
| Database     | Meetings           | One row per external meeting; brief at the top of the page, notes below                    |
| Database     | People             | One row per outside attendee, keyed by email                                               |
| Database     | Companies          | One row per outside company, keyed by email domain                                         |
| Database     | Workflow runs      | One row per calendar ingest run; add a row to run a catch-up now (linked under Debug Data) |
| Custom agent | Meeting researcher | Web research plus email summary, returned as JSON                                          |
| Custom block | main_ui            | Setup progress, then company and people cards for the next meeting and a Today view        |

## Workflows

Each workflow keeps its key (used by `ntn workers exec`); the name is what
Notion shows.

- **Sync calendar** (`calendarIngest`): runs hourly, when a row is added to
  Workflow runs, or by hand. It has no calendar event triggers, so changes
  show up within the hour. Each run scans 1 day back and 7 days ahead and
  upserts Meetings by event ID, People by email, and Companies by domain. A
  cancelled or declined event marks its meeting Cancelled, and so does an
  event that a complete scan no longer returns (deleted). On first run it
  adds the two-way relations (Attendees, Companies, Company), which the SDK
  cannot declare yet. Each run
  is logged in Workflow runs as Pending, then Success or Failed; adding a row
  there, or pressing **Sync calendar** in the block, runs a catch-up. A run
  that crashes or times out stays Pending, because the SDK has no hook for
  that yet. Its manual trigger takes no input and is always a catch-up.
- **Research companies and people** (`meetingPrep`): a Meetings row is
  created, its attendees change, or **Regenerate prep** is ticked. Searches
  Gmail (last 90 days, 10 threads per attendee), calls the researcher agent,
  and rewrites the **Meeting prep** section. Anything under **Notes** is left
  alone. Its manual trigger takes no input and works through the research
  backlog (see below).
- **Refresh today's research** (`morningPrep`): every day at 07:45 in
  `TIME_ZONE`, it refreshes the prep for that day's meetings. Its manual
  trigger takes no input and refreshes today.

### Research backlog

Research runs per meeting: one session covers a meeting's brief, its
attendees, and their companies. A manual **Research companies and people** run
therefore picks meetings that together cover everyone not yet researched
(`src/workflows/lib/backlog.ts`). Among meetings that are not cancelled and
started in the last 30 days:

- **First**, meetings that include a person or company research has never
  reached, and that no earlier pick already covers. Research stamps
  **Researched at** on every attendee and company when a session returns,
  even if it found nothing, so each record is researched once. (Records
  researched before that property existed count through Role, Confidence, or
  Summary.) A failed session stamps nothing, so its records stay in the
  backlog.
- **Then**, upcoming meetings whose prep never finished: Prep status empty,
  Queued, or Failed.

Skipped: meetings without outside attendees; meetings Researching now, unless
nothing has changed for 20 minutes, when they count as stuck and are retried;
and Failed meetings whose last attempt was less than 6 hours ago
(`FAILED_RETRY_MS`). That cooldown keeps a persistent failure from taking a
slot on every run. Within each group, upcoming meetings go first, soonest
first, then past meetings, most recent first. Each run preps at most 10
meetings (`BACKLOG_MAX_MEETINGS`) and logs how many are left; run it again
to continue.

## Block states

The block works out what to show from Workflow runs and Meetings; it stores
no state of its own (`blocks/main_ui/state.ts`):

| State       | When                                                         | Shows                                                      |
| ----------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| Never run   | Workflow runs is empty                                       | A **Sync calendar** button                                 |
| Waiting     | The newest run (by Started) has no Status                    | "Waiting for flow to start"                                |
| Syncing     | The newest run is Pending                                    | "Reading latest calendar events"                           |
| Researching | The newest run succeeded and meetings are Queued/Researching | "Researching companies and people (k of n meetings ready)" |
| Failed      | The newest run failed                                        | The run's Error and a **Retry sync** button                |
| Ready       | The App is populated, or nothing above applies               | The next meeting and Today views, or an empty state        |

Once the App is populated it always shows Ready, never a setup, loading, or
error state again. Populated means any of these, each of which only grows:

- a meeting has Prep status Ready or Failed, or **Prep updated** set;
- a sync succeeded and there are no outside meetings at all, which shows an
  empty state explaining that meetings sync hourly and coworker-only
  meetings are hidden; or
- two syncs have succeeded.

The block also latches populated for the session. Queries report loaded
only after their first real result, and keep their last rows while a
changed query (such as the hourly date cutoff) reloads, so nothing flashes.
After that, a query error is a small notice above the last good data.

In "k of n", taken from the upcoming-meetings query, n counts the meetings
research will cover: not cancelled, with outside attendees, and not yet
ended or being researched now (prep skips meetings that have ended). k
counts those whose Prep status is Ready or Failed, so a failure does not
stall the count. A meeting Queued or Researching with no change (Prep
updated or last edit) for 20 minutes counts as stuck: it leaves n, the
status line suggests Regenerate prep, and the button comes back. A manual
**Research companies and people** run also retries it.

The button adds a Workflow runs row (Trigger "Run now", Started now), which
starts **Sync calendar** like a row added by hand. It is disabled while a run
is waiting, syncing, or researching, and after a click until a new run row
appears or a minute passes. A run that has waited or stayed Pending for more
than 20 minutes (timed from Started, or the row's creation when Started is
empty) is treated as stuck, and the button comes back.

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

The custom block's key is `main_ui`: it comes from the file name
`src/customBlocks/main_ui.ts`, and its browser source is in `blocks/main_ui/`.
Its display name is **Perfect Meetings** and its slash command is
`/perfect-meetings`.

The App's name is the title of its home page. Set it on the first deploy:

```shell
ntn apps deploy --name "Perfect Meetings"
```

## Run on demand and debug

Every workflow has a manual trigger, and none takes input. Run it from the
workflow in Notion, or with `ntn workers exec`, and read the result with
`ntn workers runs list` and `ntn workers runs logs <run-id>`. For a calendar
catch-up you can also press **Sync calendar** in the block or add a row to
**Workflow runs**. Wait for the catch-up to finish before refreshing briefs
for new meetings.

```shell
# Calendar catch-up: the hourly scan, on demand.
ntn workers exec calendarIngest -d '{}'

# Research everyone not yet researched, up to 10 meetings per run.
ntn workers exec meetingPrep -d '{}'

# Refresh today's briefs.
ntn workers exec morningPrep -d '{}'
```

To rewrite one meeting's brief, tick **Regenerate prep** on it.

The "List calendar events" step in each ingest run records a diagnostic
summary: events per calendar, why events were skipped, and a tally of attendee
domains. When a run finds no meetings, check it first.

To treat coworkers as outside attendees, for example to test with internal
meetings, set `INCLUDE_INTERNAL_ATTENDEES` on your own worker. It applies to
every trigger:

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
