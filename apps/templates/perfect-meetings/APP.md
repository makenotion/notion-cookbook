# Meeting Prep

Meeting Prep watches your Google Calendar for meetings with people outside your company, then writes a short brief for each one.

## How it works

- **Calendar ingest** runs whenever an event is created, updated, or cancelled, and hourly as a backfill. Any event with an attendee whose email domain differs from yours becomes a row in **Meetings**. Each outside attendee becomes a row in **People**, and each outside domain becomes a row in **Companies**.
- **Meeting prep** runs when a meeting first appears, when its attendees change, or when you tick **Regenerate prep**. It reads recent Gmail threads with each attendee and asks the **Meeting researcher** agent to write four short paragraphs: the company, each person's role, recent email interactions, and the likely objective.
- **Morning prep** refreshes the brief for every meeting happening today at 7:45 am.

The brief sits at the top of each meeting page under **Meeting prep**. Take your notes under **Notes**; refreshing the prep never touches them.

Open the **Next meeting** view on Meetings to see a prep card for your current or upcoming meeting.

To run the calendar ingest immediately, add a row to **Run now**.

## Meetings

<database url="{{meetings-db}}">Meetings</database>

## People

<database url="{{people-db}}">People</database>

## Companies

<database url="{{companies-db}}">Companies</database>

## Run now

<database url="{{run-now-db}}">Run now</database>
