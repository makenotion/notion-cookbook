# Meeting Prep

> [!WARNING]
> Notion Apps and the Apps SDK are early alpha features and can introduce
> breaking changes.

A Notion App that turns Google Calendar meetings with outside attendees into
Notion pages with a short research brief.

## What it creates

| Kind         | Name                       | Purpose                                                                                           |
| ------------ | -------------------------- | ------------------------------------------------------------------------------------------------- |
| Page         | APP.md                     | Home page with Today, live research progress, library links, and collapsed help                   |
| Page         | Perfect Meetings Resources | Parent of the four app databases for demo cleanup                                                 |
| Database     | Meetings                   | One row per external meeting; brief at the top of the page, notes below                           |
| Database     | People                     | One row per outside attendee, keyed by email                                                      |
| Database     | Companies                  | One row per outside company, keyed by email domain                                                |
| Database     | Workflow runs              | One row per calendar ingest run; add a row to run a catch-up now (linked under How it works)      |
| Custom agent | Meeting researcher         | Researches Ready rows and writes profiles and meeting briefs directly                             |
| Custom block | main_ui                    | Setup progress, then a Today view (the default) and company and people cards for the next meeting |

## Demo cleanup

New installations group Meetings, People, Companies, and Workflow runs under
**Perfect Meetings Resources**, linked from `APP.md`. Database rows live under
their databases. Resource IDs and the existing library links stay unchanged.

Before moving the resources page to Trash, stop the app workflows and the
Meeting researcher so they do not continue using the deleted databases. Trashing
the page also trashes the child databases and their rows, including user notes.
This is not an uninstall: the app home, worker, workflows, and Meeting researcher
remain. The Apps SDK does not support parenting a custom agent to a page.
Existing linked resources should remain outside this cleanup page.

For existing installations, deployment preserves the databases' existing parents.
After updating, move the four app-created databases into the resources page
manually and confirm their parents. Do not move shared or linked databases.

## Home page

`APP.md` leads with a short explanation and Today, the main place to start a
sync or open a meeting's prep. The block owns first-run instructions and live
status so the page stays useful on return visits. Below it, **Your library**
links to Meetings, People, and Companies. A collapsed **How it works** section
explains notes, automatic updates, refreshing briefs, and calendar sync history.

The home page starts with a compact setup card: what meeting prep does, a
**Begin Sync** action, and the automatic sync and morning refresh schedule.
After starting, a live checklist tracks calendar sync, participant research,
company research, and meeting briefs independently. Failures, stale work, and
partial counts are labeled; failed briefs are never counted as ready.

Below Today, compact People and Companies rows show nonzero research counts:
actively researching, queued (`Ready`), completed (`Done`), failed, stalled, and
not yet queued. Only actively researching records animate. Work with no update
for 20 minutes is labeled as possibly stuck. Empty libraries show a short hint
instead of zero-filled panels. Counts refresh automatically using the live queries. Loading and query
errors are shown separately from zero counts. Each source supports up to 999
rows in this view; when more exist, the overview labels its counts as partial.

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
  there, or pressing **Begin Sync** in the block, runs a catch-up. A run
  that crashes or times out stays Pending, because the SDK has no hook for
  that yet. Its manual trigger takes no input and is always a catch-up.
- **Prepare research** (`meetingPrep`): a Meetings row is created, its
  attendees change, or **Regenerate prep** is ticked. Collects calendar history and contact names, saves
  **Research context**, and waits for the meeting's People and Companies to finish
  research before setting **Research status → Ready**. Its manual
  trigger also queues existing unresearched People and Companies.
- **Refresh today's research** (`morningPrep`): every day at 07:45 in
  `TIME_ZONE`, it prepares fresh context and queues briefs for today's
  meetings after their participant and company research finishes. Its manual
  trigger takes no input and refreshes today. Both workflows return after
  queuing the brief; they do not wait for the brief itself to finish.

### Ready handoff

Ingestion creates each Person and Company with its identifying fields and
relations, then sets **Research status → Ready** in a separate update. The
Meeting researcher has native property-edit triggers on Research status in
People, Companies, and Meetings, plus edit access to those databases. It reads
the triggering row, processes only Ready rows, and writes results directly:

**Ready → Researching → Done / Failed**

The installed SDK watches property edits without a value filter, so other
status edits also invoke the agent; its instructions require those runs to
exit without doing research. The status check is an agent instruction, not an
atomic lock or an exactly-once guarantee. Native trigger execution and agent
writes require live verification after deployment.

People and Companies are researched independently of their meetings' dates.
The agent writes a **Profile** section above **Notes**, fills supported
properties, records sources, and stamps **Researched at** after completion,
even if it found nothing. It preserves user notes and existing profile URLs;
a Low-confidence match cannot replace a High one. Sync retries do not reset
Ready, Researching, Done, Failed, or previously researched records.

For Meetings, the agent reads saved profiles and **Research context**, writes
**Meeting prep** above **Notes**, and sets **Prep status → Ready**, **Prep
updated**, **Prepped for**, and **Research status → Done**. Prep status Ready
means the brief is available; Research status Ready means work is queued.
While profiles are pending, **Prep status stays Queued** and the block shows
“waiting for research.” The workflow checks only that meeting's participants
and their companies every 30 seconds using durable waits, then builds context
from the completed profiles. Done profiles (including research that found no
confident match) and legacy profiles with saved research are accepted. Missing
profiles remain pending; never-requested profiles are queued automatically.
Failed profiles fail the prep immediately; pending research times out after
20 minutes. The reason is saved in Research context and the workflow error.
Retry the affected profiles, then tick Regenerate prep on the meeting.
The agent rechecks profile completion before writing and never repeats their
web research. Only then does **Prep status become Researching**. Each handoff
and failure write rechecks the request identity, attendees, and cancellation
state to discard stale requests.
The workflow consumes Regenerate prep before waiting; the agent leaves it alone.

Set a Person or Company's Research status back to **Ready** to retry or refresh
it. For a Meeting, tick **Regenerate prep** to rebuild context and queue a
fresh brief. If an agent run stops before recording failure, its row may remain
Researching; check the agent's activity before retrying it.

### Manual catch-up

Run **Prepare research** manually to queue People and Companies with no
Research status and no existing research (Researched at, Role, Confidence,
or Summary). This includes profiles with no upcoming meeting. Already queued,
completed, and failed profiles are left alone; retry Failed explicitly with
Ready.

The same run prepares at most 10 meeting briefs from the last 30 days:
meetings covering never-queued profiles first, then unfinished upcoming
briefs. It excludes cancelled meetings, meetings without attendees, recent
failures (6-hour cooldown), and research active within the last 20 minutes.
These bounds apply to manual meeting selection, not native profile triggers.
Automatic meeting prep still skips ended meetings; an explicit Regenerate
prep request can prepare them. Run manual catch-up again if more briefs remain.

## Block states

The block works out what to show from Workflow runs and Meetings; it stores
no state of its own (`blocks/main_ui/state.ts`):

| State       | When                                                         | Shows                                                                           |
| ----------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Never run   | Workflow runs is empty                                       | Instructions, schedule, and a **Begin Sync** button                             |
| Waiting     | The newest run (by Started) has no Status                    | Calendar stage waiting for the run                                              |
| Syncing     | The newest run is Pending                                    | Calendar stage active; research updates independently                           |
| Researching | The newest run succeeded and meetings are Queued/Researching | Live participant, company, and meeting-brief progress                           |
| Failed      | The newest run failed                                        | The run's Error and a **Retry sync** button                                     |
| Ready       | The App is populated, or nothing above applies               | The Today (default) and Next meeting views, or an empty state with **Sync now** |

Once the App is populated it always shows Ready, never a setup, loading, or
error state again. Populated means any of these, each of which only grows:

- a meeting has Prep status Ready or Failed, or **Prep updated** set;
- a sync succeeded and there are no outside meetings at all, which shows an
  empty state explaining that meetings sync hourly and coworker-only
  meetings are hidden; or
- two of the 10 most recent syncs have succeeded.

The block also latches populated for the session. Queries report loaded
only after their first real result, and keep their last rows while a
changed query (such as the hourly date cutoff) reloads, so nothing flashes.
After that, a query error is a small notice above the last good data.

Calendar status is independent of research. It follows the newest Workflow runs
row, displays freshness from **Finished** after success, and shows a failure or
possibly-stuck message when needed. A run waiting or Pending for more than
20 minutes (from Started, or row creation when Started is empty) allows retry.
Missing status data and query failures are distinct from successful syncs.

The **Sync now** button adds a Workflow runs row (Trigger "Run now", Started
now). It is disabled while calendar sync is waiting or running, when its status
is unavailable, and after a click until a new run appears or a minute passes.
People and company research continue independently and do not disable sync.

The block reads four live queries (`blocks/main_ui/derive.ts`): Meetings
from local midnight 3 days ago onward (up to 200, not cancelled), the 10
newest Workflow runs, People, and Companies. The next meeting, Today,
progress, and populated signals are all derived from those rows. The SDK
re-sends every subscription's query whenever the host reports a change to
its data source, with no debounce, so research writes multiply requests per
subscription; keep the count low. The Meetings window changes once a day,
so the query is not replaced between renders. When a query fails before any
rows have loaded, the block shows the error with **Retry**, not an empty
state.

Every empty state in the ready UI explains what was checked and puts the next
action first: **Sync now**, **Retry sync**, or **View next meeting** when today
is empty but a future meeting exists. The block stays on the ready UI while
syncing and keeps calendar health and the automatic schedule visible below.

All block states fill their container. Company and person cards use a responsive
grid, with names first, quiet contact details, compact profile links, and a
**Possible match** badge for low-confidence research. Profile activity follows
each profile's own status, independently of meeting-brief progress.

"External" means an attendee's email domain is not your account's domain or
one of its coworker domains. Consumer mailboxes such as gmail.com get a People
row but no Company row.

## Configure

After deploying, open workflow setup for
**Sync calendar**, **Prepare research**, and **Refresh today's research**.
Connect your Calendar account, approve read access, and select the same calendar
for each workflow's **meetings** target. Each target requires exactly one
calendar. Event scans, history reads, and contact lookups pass that target
explicitly; they do not use an account's global default.

Existing installations need to deploy these target declarations and select
their calendar again before running the workflows. A successful build does
not configure or publish the connection.

Set `TIME_ZONE` and `MORNING_PREP_TIME` in `src/lib/schedule.ts` (defaults:
`America/Los_Angeles`, `07:45`). The workflows and onboarding copy share these
settings. `src/lib/config.ts` sets the backfill window (1 day back, 7 days ahead).

Gmail research is temporarily disabled in both **Prepare research** and
**Refresh today's research**. They require only the Calendar connection, skip
mailbox lookup and email search, and tell the researcher that email was not
checked. Calendar history, contacts, and profile research remain available.
Existing briefs are not rewritten until refreshed. Mail parsing helpers remain
for a future restoration; no Mail connection is declared.

## Develop

```shell
npm install
npm run check
npm test
npm run build
```

The block uses shadcn/ui Button, Card, Badge, Progress, Tabs, and Avatar
components in `blocks/main_ui/components/ui/`. Tailwind utilities are
mapped to Notion's live design tokens in `shadcn.css`, with no global CSS reset.

Start the local mock host with `ntn workers customblocks dev --port 9873`.
It hot reloads UI edits. Its data is local; pressing Begin Sync creates a mock
run request, but does not execute deployed workflows.

The custom block's key is `main_ui`: it comes from the file name
`src/customBlocks/main_ui.ts`, and its browser source is in `blocks/main_ui/`.
Its display name is **Perfect Meetings** and its slash command is
`/perfect-meetings`. It opens on **Today**; a viewer's last tab is remembered
in their browser, so new viewers start on Today.

The App's name is the title of its home page. Set it on the first deploy:

```shell
ntn apps deploy --name "Perfect Meetings"
```

## Run on demand and debug

Every workflow has a manual trigger, and none takes input. Run it from the
workflow in Notion, or with `ntn workers exec`, and read the result with
`ntn workers runs list` and `ntn workers runs logs <run-id>`. For a calendar
catch-up you can also press **Begin Sync** (or **Sync now**) in the block or add a row to
**Workflow runs**. Wait for the catch-up to finish before refreshing briefs
for new meetings.

```shell
# Calendar catch-up: the hourly scan, on demand.
ntn workers exec calendarIngest -d '{}'

# Queue unresearched profiles and prepare up to 10 meeting briefs.
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

This applies only to the worker you set it on. New profiles and meeting briefs it lets
through are queued for the agent, so turning it on for a busy calendar uses
AI credits quickly. Rows it creates remain after you unset it.

Notes:

- New page watches and schedules take effect after you open the workflow in
  Notion and save it.
- Workflow success confirms context preparation or ingestion, not agent
  completion. Check Research status and the Meeting researcher's activity for
  profile results, and Prep status for finished briefs.
- Deploy this change with `ntn apps deploy`, then verify the Meeting
  researcher's property watches and database edit access in Notion. Test one
  Ready Person and one Ready Company, including a profile imported from a
  past meeting. Confirm profiles and Researched at are written, Done edits
  cause no further research, and Notes survive a retry. Build and offline
  tests cannot verify native trigger delivery or agent behavior.
