# Choice cards

A choice card is a question with clickable options. It lets the person make the structural decision in one tap, while the agent does the rest.

## Rules (required)

- **Use the platform's built-in choice UI,** never plain text: the ask-user-question tool in Claude, clickable choices in ChatGPT, `request_user_input` in Codex. Put the question text in the question field and each option as its own choice.
- **2–4 options. The recommended option goes first, marked "(Recommended)".**
- **Every option shows its full description,** exactly as written below, adapted to the person's words. If the UI only shows labels, write "Name: description" in the label. Never show an option name alone.
- **Use multi-select** for the pieces card; everything else is single-select.
- **Fallback:** only if there is no choice UI at all, show a numbered list with the descriptions and end with "Reply with a number."
- **When:**
  - At most one card before the first build, and one after it.
  - Skip any card the conversation already answers. If the person says "just do it," use the recommended option and say which one.
  - A card never replaces information you can find yourself. Don't ask people to design fields or approve rows.
- **After a choice,** confirm it in one line, then act, e.g. "✅ Adding it to your Projects."

## Card 1: setup (before the first build)

Choose the variant from what you found.

**No existing Projects or Tasks database, and a usual-size plan:**

> **How should we set up [plan name]?**
>
> 1. **Project with tasks (Recommended):** a plan page with a Tasks database you can see as a board or calendar. Best when there are several steps, dates or people.
> 2. **Simple checklist:** one page with a checklist. Good for a short, one-off plan; you can turn it into a database later.

**A team, ongoing work, or more projects coming, and no Projects database yet:**

> **How should we set up [plan name]?**
>
> 1. **Notion Projects (Recommended):** a Projects database and a Tasks database, so this project and future ones live in one place with every task connected.
> 2. **Just this plan:** one plan page with its own task list.

**A Projects database already exists:**

> **Where should [plan name] live?**
>
> 1. **Add to [Projects database name] (Recommended):** it becomes a project there, with its tasks in your [Tasks database name], next to your other work.
> 2. **Keep it separate:** a private plan page with its own task list.

If you find several Projects databases, list the most likely two by name and add "Somewhere else."

## Card 2: pieces (after the first build, multi-select)

> **Want to add any of these to [plan name]?**

Offer only the 2–4 pieces that fit this plan, using the use case's likely pieces. Example options:

- **Calendar view:** see every due date on a calendar.
- **Timeline:** see milestones and how the work overlaps.
- **Progress chart:** a chart of tasks by status, for launches and team projects.
- **RSVP form:** guests reply through a form and land in your guest list.
- **Share with [names]:** they see the plan and their own tasks. Confirm each person and access level first.
- **Kickoff on your calendar:** a Notion Calendar event with a meeting note linked to the plan. Confirm attendees first; they'll be notified.
- **Weekly check-in:** a recurring calendar slot with a linked meeting note, where we review what moved, what's stuck and what's next.
- **Keep it moving:** every Monday I'll check what moved, what's stuck and what's next, and update the plan. Offer this only for plans that run over weeks, and only if the agent can schedule.
- **Reminders:** a nudge the day before each due date. Set the reminder on the task date.
- **Finished visuals in Canva:** on-brand posts in every size, each linked to its row. Offer this only when the plan needs visuals and the person has no design tool; if they have one, name their tool instead.
- **A web page:** publish the plan as a Notion Site (public, so confirm first), or a custom landing page with Vercel when they need a real site.

Build what they choose. If something can't be built through the connection, give the manual step from [the Notion way](notion-way.md).

## Card 3: a trade-off (update mode)

Use it when a change forces a decision that belongs to the person.

> **The design review moved to Nov 12. What should give?**
>
> 1. **Move the launch to Nov 26 (Recommended):** keeps the full scope; the announcement and help article move with it.
> 2. **Keep Nov 19 and cut the onboarding tour:** ships on time; the tour follows in a later release.

## Visuals: concepts or finished (only when it's unclear)

> **What do you need for the visuals?**
>
> 1. **Quick concepts (Recommended for now):** rough images to react to before anything is final.
> 2. **Finished posts:** your text, logo and sizes, ready to publish.

For which tool fits each, see [tools that work with Notion](tools-that-work-with-notion.md).
