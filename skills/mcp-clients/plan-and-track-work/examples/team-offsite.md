# Example: plan a team offsite from scratch

A fictional example of the full "start a plan" flow, including the choice cards. Adapt the names and content; keep the shape.

## The request

> Help me plan our design team offsite: 12 people, March 19–20, 2027, around $6,000.
> Priya is co-organizing. We haven't picked a venue yet. We want one day of
> workshops and one day outside.

Search finds no plan for the offsite, and no Projects or Tasks database in the workspace.

## Card 1: setup (built-in choice UI, single-select)

> **How should we set up the design team offsite?**
>
> 1. **Project with tasks (Recommended):** a plan page with a Tasks database you can see as a board or calendar. Best when there are several steps, dates or people.
> 2. **Simple checklist:** one page with a checklist. Good for a short, one-off plan; you can turn it into a database later.

The person picks 1. The agent confirms in one line: "✅ Setting it up as a project with tasks."

## What gets built

**🏕️ Design team offsite** is a private page. Its first screen:

- **Goal:** a two-day offsite for 12 people, March 19–20, 2027, around $6,000 · Organizers: you and Priya (written as text until her account is confirmed).
- **Next action callout:** "Shortlist 3 venues that fit 12 people and both days. Due Jan 15."
- **Tasks:** an open-work view sorted by due date.

The **Offsite tasks** database (inside the page) has Status (To do → In progress → Done), Owner, Due and Cost (estimated or confirmed):

| Task                                 | Status   | Owner | Due    |
| ------------------------------------ | -------- | ----- | ------ |
| Shortlist 3 venues                   | To do    | —     | Jan 15 |
| Book venue and confirm price         | To do    | —     | Jan 29 |
| Plan workshop day agenda             | To do    | —     | Feb 12 |
| Choose and book the outdoor activity | To do    | —     | Feb 19 |
| Send calendar hold to the team       | To do    | —     | —      |
| Day-of run sheet                     | Drafting | —     | —      |

- **Due dates** are proposed, working back from March 19, and the page says so.
- **Task pages have real content:** the venue task lists the requirements (12 people, a workshop room, near the outdoor option), and the run sheet has a timed draft for both days.
- **Views:** Board by status, and "Needs a date."
- **Budget line:** "$6,000 budget · no costs confirmed yet." It doesn't claim any amount is left.

## The delivery message

> Your offsite plan is ready: [Design team offsite]. Your tasks live in a database,
> so each one is its own page, and the board and the "Needs a date" list are two
> views of the same tasks. First up: shortlist three venues by Jan 15.

## Card 2: pieces (multi-select, only what fits)

> **Want to add any of these to the offsite?**
>
> - **Calendar view:** see every due date on a calendar.
> - **RSVP form:** the team confirms attendance and dietary needs through a form that fills your guest list.
> - **Share with Priya:** she sees the plan and the tasks assigned to her.
> - **Reminders:** a nudge the day before each due date.

The person picks Calendar, RSVP form and Share with Priya:

- **Calendar view:** created.
- **RSVP form:** a private Guests database (Name, Attending, Dietary needs, Notes) gets a form view, so responses arrive as rows. The form stays closed until the person confirms who can submit.
- **Share with Priya:** her account is found, and the sharing change is previewed (Priya, can edit). It's only saved after an explicit yes. Then she's assigned "Plan workshop day agenda."

## The reason to come back

> I've set the venue task for Jan 15. Want a 15-minute check-in on your calendar
> each Monday until the offsite, with a meeting note linked to this plan?

On a yes, the agent creates the recurring Notion Calendar event with you and
Priya as attendees, then the linked meeting note.

Not built here: no venue was invented, no costs were guessed, no one was invited without a yes, and nothing was booked or sent.
