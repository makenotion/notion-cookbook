Reads your external meetings, researches companies and participants, and provides prep materials.

<database inline="true" data-source-url="{{meetings-next-view}}">Next meeting</database>

Switch to **Today** to see the day's meetings on a calendar, with the current or next one highlighted. Click a meeting to see its company and attendee cards.

<database inline="true" data-source-url="{{meetings-upcoming}}">Upcoming meetings</database>

<database inline="true" data-source-url="{{sync-runs-recent}}">Workflow runs</database>

Add a new row to sync your calendar now.

---

## How it works

Perfect Meetings helps you prepare for meetings with people outside your
company. It brings your Google Calendar meetings into Notion and writes a
brief about the companies, attendees, recent Gmail conversations, and likely
meeting objective.

Open a meeting to review its **Meeting prep** and take notes under **Notes**.
Refreshing the prep leaves your notes untouched. Tick **Regenerate prep** to
request a fresh brief or retry a failed one. Each person's **Confidence** shows how
sure the researcher is of their name and role. Low means it matched only part
of the name, such as a first name at the right company; their card shows
"(low confidence)", and a later brief may correct them. Set it to High once
you have checked a person to keep their name and role.

Each brief also updates a **Profile** at the top of each attendee's page in
**People**: their role and responsibilities, meetings with them in the last 90
days, a summary of recent meetings and email, and a recent public post when
one is found. Write your own notes under **Notes** on that page; refreshes
leave them untouched.

Meetings update when calendar events change, with an hourly catch-up, and
every catch-up is logged in **Workflow runs**. Briefs are prepared for new
meetings and refreshed when attendees change. Today's briefs also refresh each
morning at 7:45 am in the app's configured time zone. To refresh today's
briefs now, manually run **Morning prep**, leaving the date empty. Meetings
with only coworkers do not appear by default.

<details>
<summary>App data</summary>
	<mention-page url="{{people-db}}">People</mention-page> — Look up outside attendees, their roles, and their profiles.
	<mention-page url="{{companies-db}}">Companies</mention-page> — Browse company summaries and websites.
	<mention-page url="{{meetings-db}}">Meetings</mention-page> — Switch to **Calendar** or **All meetings** to browse dates and past notes.
	<mention-page url="{{sync-runs-db}}">Workflow runs</mention-page> — Every calendar catch-up, with its status and any error.
</details>
