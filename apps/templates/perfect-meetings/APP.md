Perfect Meetings helps you prepare for meetings with people outside your
company. It brings your Google Calendar meetings into Notion and writes a
brief about the companies, attendees, recent Gmail conversations, and likely
meeting objective.

## Your next meeting

See who you are meeting with now or next. Choose **Open prep** to read the
brief, or select a person's avatar to open their details.

<database inline="true" data-source-url="{{meetings-next-view}}">Next meeting</database>

## Upcoming meetings

Open a meeting to review its **Meeting prep** and take notes under **Notes**.
Refreshing the prep leaves your notes untouched. Check **Prep status** to see
whether a brief is queued, researching, ready, or failed. Tick
**Regenerate prep** to request a fresh brief or retry a failed one.

<database inline="true" data-source-url="{{meetings-upcoming}}">Upcoming meetings</database>

Meetings update when calendar events change, with an hourly catch-up. Briefs
are prepared for new meetings and refreshed when attendees change. Today's
briefs also refresh each morning at 7:45 am in the app's configured time zone.

## Refresh now

To check for new calendar events, manually run **Calendar ingest** with mode
**backfill**, leaving the other inputs empty. To refresh today's briefs,
manually run **Morning prep**, leaving the date empty. These are separate runs;
wait for the calendar catch-up to finish before refreshing the briefs.
Meetings with only coworkers do not appear by default.

## People, companies, and meeting history

- <mention-page url="{{people-db}}">People</mention-page> — Look up outside attendees and their roles.
- <mention-page url="{{companies-db}}">Companies</mention-page> — Browse company summaries and websites.
- <mention-page url="{{meetings-db}}">Meetings</mention-page> — Switch to **Calendar** or **All meetings** to browse dates and past notes.
