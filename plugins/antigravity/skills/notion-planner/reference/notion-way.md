# The Notion way

Every Notion setup is the same few pieces in a different context. A team offsite, a job search and a product launch are the same build with different names and data. Keep that structure; adapt the words, fields and content.

The agent drafts the content, and the person chooses the structure. Explain how the pieces connect when that helps the person use the plan.

## The building blocks

| Piece              | What it is                                               | In a plan                                                         |
| ------------------ | -------------------------------------------------------- | ----------------------------------------------------------------- |
| **Page**           | A document you can write in and nest                     | The plan's home: goal, next action, milestones, status            |
| **Database**       | A collection of pages with properties                    | The Tasks: one row per piece of work, each one a page             |
| **Properties**     | Typed fields on each row                                 | Status, Owner, Due, Project, plus one or two that fit the work    |
| **Views**          | Different ways to see the same database                  | Board by status, calendar by due date, timeline, "Needs a date"   |
| **Relations**      | Links between databases                                  | A task belongs to a project; a post belongs to a campaign         |
| **Data coming in** | Forms and connected apps                                 | RSVPs, sign-ups and requests become rows automatically            |
| **Keep it moving** | Reminders, automations, recurring templates              | Due-date reminders, a weekly post template, a status-change alert |
| **AI**             | Notion AI and agents, plus ChatGPT or Claude through MCP | Drafting, summarizing, the weekly check-in                        |
| **Sharing**        | Inviting people to pages and assigning them work         | Teammates see their own tasks in the plan                         |

## How much structure to start with

| Situation                                      | Build                                                                                                             | Grow it later by                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Fewer than about 5 steps, one person, one-off  | A plan page with a checklist                                                                                      | Turning the checklist into a Tasks database when it grows          |
| The usual case: several steps, dates or people | A plan page plus a Tasks database, with a board or table view and a "Needs a date" view                           | Adding views, reminders, a form or sharing through the pieces card |
| A team, several projects, or ongoing work      | **Notion Projects:** a Projects database (this plan is one project row) and a shared Tasks database related to it | Reusing it for every future project                                |

- **Use Notion's typed databases when creating new ones:** `projects` and `tasks` (`create-database` with `database_type`). Notion recognizes these, so other features work with them.
- **Reuse an existing Projects or Tasks database** before creating anything.

## Fields that fit the work

Keep the four core fields: Status, Owner, Due and Project. Rename the status steps and add at most two more fields that fit the work:

| Work       | Rows are        | Status steps                                         | Extra fields                    |
| ---------- | --------------- | ---------------------------------------------------- | ------------------------------- |
| Event      | Preparations    | To do → In progress → Done                           | Cost (estimated or confirmed)   |
| Job search | Applications    | Interested → Applied → Interviewing → Offer / Closed | Company, Follow-up date         |
| Content    | Posts           | Idea → Drafting → Ready → Published                  | Channel, Publish date           |
| Launch     | Deliverables    | To do → In review → Done                             | Workstream                      |
| Trip       | Itinerary items | To book → Booked → Done                              | Time and timezone, Confirmation |

## Show the bricks, once

After the first build, name the pieces in one or two sentences, using the person's own words:

> "Your offsite tasks live in a database: each task is its own page. Board and Calendar are two views of the same tasks, so update a task anywhere and it changes everywhere."

Don't explain again on later runs, or if the person already uses databases and views.

## Add views, collaboration and follow-up

Check tool access once (`get-tool-access`), then build what's supported. For anything else, give one exact manual step and don't claim it exists. Anything that reaches other people (calendar invitations, sharing, publishing) needs an explicit yes for that exact change first.

| Piece                                                                    | How to build it                                                                                                                                       | Needs a yes first?                                               |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Pages, typed databases, properties, relations                            | `create-pages`, `create-database` (`database_type` `projects` or `tasks`), `update-data-source`                                                       | No                                                               |
| Views: table, board, list, calendar, timeline, gallery, chart, dashboard | `create-view`, configured with filters, sorts and grouping                                                                                            | No                                                               |
| Form (RSVPs, sign-ups, requests)                                         | `create-view` type `form` on the database it fills. Set who can submit; responses arrive as rows                                                      | Yes, before opening it to others                                 |
| Kickoff or check-in meeting                                              | `notion-calendar-create-events`. Use a recurrence rule for a weekly check-in, then `create-meeting-note` linked to the event                          | Yes, since attendees get notified                                |
| Meeting notes                                                            | `create-meeting-note`, filed with the plan or linked to its calendar event                                                                            | No, for the person's own notes                                   |
| Share with a teammate                                                    | `load-permissions`, then `update-permission` with the least access needed. It previews first and only saves after their yes                           | Yes, for each person and access level                            |
| Publish as a Notion Site or public link                                  | `update-permission` with `isSite` or `isPublicShareLink`, defaulting to view-only                                                                     | Yes, because it's public                                         |
| Pin to the sidebar                                                       | `update-page-favorites` adds the plan to their Favorites                                                                                              | No. Do it by default for a new plan and say so; never on updates |
| Scheduled check-in ("keep it moving")                                    | The agent's own scheduler: scheduled tasks in Claude, automations in Codex, tasks in ChatGPT. Each run does a check-in and updates the Status section | Yes: confirm the day, time and where results go                  |
| Run an existing Notion agent                                             | `list-agents`, then `spawn-session` (only agents that already exist)                                                                                  | Yes                                                              |
| Reminders                                                                | Set a reminder on the task date using the connected tool's current schema                                                                             | No                                                               |
| Automations, such as notifying on a status change                        | Configure the trigger and action on the Tasks database                                                                                                | Yes, before enabling notifications                               |
| Recurring tasks                                                          | Configure a repeating task template with the agreed cadence                                                                                           | Yes, before enabling the schedule                                |
