# Update a plan and check in

Most project management happens after day one. This skill also handles those moments, always on the same plan and records.

## Find the plan

Search by name, or use the link. Read the home, the Status section and the open tasks. If there's no plan yet, switch to "Start a plan."

## Update: add work, move dates, a slip, a scope change

1. **Change the records themselves:** add or split tasks, move dates, reassign. Keep the history: completed work, comments and earlier decisions.
2. **Show the knock-on effects:** which dependent tasks and milestones move, and what is now at risk. Never squeeze the schedule quietly to keep the old date.
3. **If it forces a trade-off** (move the date, cut scope, add people), the person decides through a choice card with a recommendation (card 3 in [choice cards](choice-cards.md)).
4. **Log the decision** in the Status section: date, what changed, why, and who decided.
5. **Answer "what's next?"** with the next one or two actions, each with its owner and date.

## Check in: weekly or ad hoc

Compare now with the last check-in, not with memory.

| Evidence                                 | What it supports                                      |
| ---------------------------------------- | ----------------------------------------------------- |
| The last check-in plus the current state | What changed between the two                          |
| A done date within this period           | Completed this period                                 |
| Status is Done, but there's no date      | Currently marked done, not necessarily done this week |
| Only an edit time                        | The record was edited; that isn't progress            |
| Status and notes disagree                | Say so, and don't pick the optimistic one             |

Write the check-in at the top of the Status section:

- **Moved:** what got done or advanced, with links.
- **Stuck:** blockers, with an owner and the next step for each.
- **Next:** the next two or three actions, with owners and dates.
- **Decisions needed:** shown as a choice card if the person is in the conversation.

With no previous check-in, write a clearly labeled first snapshot, and don't claim trends.

## Bring them back

Offer one way to make the check-in happen again, as a pieces-card option, in this order of preference:

- **A scheduled check-in run by the agent** ("Keep it moving"): a scheduled task in Claude, an automation in Codex, a task in ChatGPT. Each run finds the plan, does the check-in above and writes it to the Status section. Name the plan's URL in the scheduled instructions. Confirm the day, time and how the person hears about it.
- **A recurring Notion Calendar event** (`notion-calendar-create-events` with a weekly recurrence rule) with a meeting note linked to the plan, for a check-in held with people. Confirm the time and attendees first.
- **An existing Notion agent** (`list-agents`, `spawn-session`).

Confirm the schedule and where results will be saved. Never claim a schedule you didn't create.
