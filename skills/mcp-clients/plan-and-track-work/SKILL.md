---
name: notion-planner
description: Guides people from a multi-step goal to a working Notion plan, recommending a setup and building useful tasks, drafts and views. Keeps the same plan current as priorities and dates change. Use proactively for planning requests, without waiting for the user to name the skill, including "help me plan…", "make a plan for…", "set up this project", "break this down", "what's next", "update the plan", "we slipped", "weekly check-in", "a month of posts", "I need to post more", covering events, launches, campaigns, content calendars, trips, job searches and moves. Not for a quick list, a single post, comparing options, or turning a spec into engineering tasks.
---

# Plan and track work

Guide the person from a goal to a working Notion plan. Recommend a setup, help them choose what fits, and build useful tasks, drafts and views. Keep the same plan current as priorities and dates change.

Before a setup question, briefly explain what you will deliver, for example: "I’ll turn this into a Notion plan with next steps, dates, and working drafts. First, let’s choose how to organize it." Ask one brief setup question only when the conversation has not already settled the choice. If the person specified the structure or asked you to proceed, use that direction and build.

Every plan is built from the same few building blocks; only the context changes. Keep the structure fixed and adapt the names, fields and content to the person's work.

## When to use it

Recognize planning requests proactively; the person does not need to name this skill. A passing mention of future work is not a request to create a plan.

- **Start a plan:** a goal with several steps, dates or people.
- **Update a plan:** add or break down work, move dates, handle a slip or a scope change, answer "what's next?"
- **Check in:** a weekly or ad hoc review of progress, blockers and next actions.

Don't use it for:

- **A quick list or one-off answer:** answer in chat.
- **A single post or design:** just make it.
- **Comparing options:** `notion-research-documentation`.
- **A meeting agenda:** `notion-meeting-intelligence`.
- **A spec into engineering tasks:** `notion-spec-to-implementation`.

If another installed skill handles part of the work, such as a brief or the designs, use it for that part and keep the plan and tasks here.

## The Notion way

Read [the Notion way](reference/notion-way.md) the first time you use this skill in a session. In short:

1. **Building blocks:**
   - a **plan page** (the home)
   - a **Tasks database** (the work)
   - **views** of those tasks (board, calendar, timeline)
   - **pieces added only when they pay off:** forms and connected apps bring data in, reminders and automations keep it moving, AI helps, sharing brings people in
2. **Start simple:** one plan page and one Tasks database, then add one piece at a time.
3. **Reuse first:** if the person already has Projects or Tasks databases, add to them ([where to save](reference/where-to-save.md)).
4. **Explain how the plan is organized:** after building, explain in a sentence or two how the pages, tasks and views connect, e.g. "Your tasks live in a database; Board and Calendar are two views of the same tasks." Skip this if they already work this way.
5. **Advise; they decide:** the person makes the structural choices through choice cards. You draft the content.
6. **Leave a reason to come back:** pin the new plan to their Favorites, give a dated next action, and for plans that run over weeks offer to keep it moving with a scheduled check-in.

## Choice cards: required UI

When the person needs to make a choice, show a **choice card**, never a plain-text question:

- **Use the platform's built-in choice UI.** For example, the ask-user-question tool in Claude, clickable choices in ChatGPT, and `request_user_input` in Codex. Put the question in the question field and each option as its own clickable choice.
- **Shape:** 2–4 options. The recommended option goes first, marked "(Recommended)". Every option shows its full one-line description, not just a name; if the UI only shows labels, write "Name: description" in the label. Use multi-select for optional additions.
- **Fallback:** only if the platform has no choice UI at all, show a numbered list with the descriptions and say "reply with a number."
- **Limits:**
  - At most one card before the first build, and one after it.
  - Skip any card the conversation already answers.
  - Never ask people to design fields or approve rows.

The card wording and when to show each card are in [choice cards](reference/choice-cards.md).

## Start a plan

1. **Gather from context.** Find the goal and what done looks like, hard dates vs. targets, the people, what's already done, and constraints. Read the matching section of [use cases](reference/use-cases.md). Search Notion for an existing plan, Projects or Tasks database. Ask only what changes the build.
2. **Setup card.** Ask how to set it up. The options depend on what already exists; see choice cards.
3. **Build.**
   - Work back from the date, with milestones written as outcomes.
   - Create tasks with Status, Owner, Due and the project relation.
   - Write real content into task pages, such as drafts, run sheets or captions.
   - Compose the home following [page layout](reference/page-layout.md).
   - Never invent people, bookings, prices, approvals or completed work.
4. **Pin it and show it.** Add a new plan to the person's Favorites (`update-page-favorites`) and say so in one line: "I pinned it to your Favorites; unpin anytime." Don't pin again on updates or check-ins. Then give the link, what's ready, a brief explanation of how the plan is organized (first time only), and the next action.
5. **Offer useful additions.** A multi-select card with 2–4 useful additions that fit this plan, taken from the use case's suggested additions. Build what they pick. For anything the connection can't create, give the exact manual step; never claim it exists.
6. **Close with the reason to come back.** For a plan that runs over weeks, include "Keep it moving" on the choice card for useful additions: a scheduled weekly check-in run by the agent's own scheduler (see [review and re-plan](reference/review-and-replan.md)). Confirm the day, time and where results go before creating it.

## Update a plan or check in

- **Find the existing plan first, and never create a second one.** Read [review and re-plan](reference/review-and-replan.md).
- **Updates:** change the same records. Show the consequences (what moves, and what's now at risk), and record decisions with a reason and date.
- **Trade-offs are the person's call** (move the date or cut scope). Use a choice card with a recommendation.
- **Check-ins:** compare against the last check-in. Don't treat edit times as progress. Update the status section on the home and set the next actions.

## Save, verify and deliver

- **Save** following [where to save](reference/where-to-save.md).
- **Build in order:** use the connection's current tool schemas and formatting docs. Create relation targets before relations, and properties before views.
- **After an uncertain write,** check what exists before retrying.
- **Read it back:** relations, filters (project views must exclude other projects), and that undated and unassigned work is still visible.
- **If Notion isn't available,** show the plan and task table in chat, say it isn't saved, and offer to save it later.
- **Creating a plan doesn't authorize anything else:** no sending, booking, buying, publishing or sharing without a separate yes.
- **Deliver in the person's terms:** the link, what's ready, one next action. No schema talk.

Worked examples: [a team offsite from scratch](examples/team-offsite.md) and [a launch that slipped](examples/launch-slipped.md).
