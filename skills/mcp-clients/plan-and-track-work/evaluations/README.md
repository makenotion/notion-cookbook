# Evaluate the planner

Use the [shared evaluation protocol](../../evaluations.md) with isolated, stateful fixtures. Compare no-skill and new-skill runs; record the tested commit.

These are specifications, not completed runs.

## Scenarios

| Scenario                                                  | What it checks                                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [start-plan-choice-card](start-plan-choice-card.json)     | Setup card using the built-in choice UI; the Notion-way structure; showing the bricks once; a pieces card with fitting options only; no invented facts |
| [reuse-notion-projects](reuse-notion-projects.json)       | Adds to an existing Projects and Tasks pair instead of creating databases; filtered project view; no re-teaching                                       |
| [small-plan-checklist](small-plan-checklist.json)         | Starts simple: a checklist for a tiny plan, no extra structure or offers                                                                               |
| [content-calendar-visuals](content-calendar-visuals.json) | Posts database with calendar and "Needs a date" views; concepts first, then Canva for finished posts as a card option                                  |
| [own-design-tool-wins](own-design-tool-wins.json)         | The user's own tool (Figma) replaces any partner suggestion                                                                                            |
| [mid-project-slip](mid-project-slip.json)                 | Triggers mid-project; updates the same records; trade-off card; decision log                                                                           |
| [weekly-checkin](weekly-checkin.json)                     | Evidence rules; Moved, Stuck, Next written in the Status section; an offer to repeat                                                                   |
| [no-choice-ui-fallback](no-choice-ui-fallback.json)       | A numbered list with full descriptions only when there's no choice UI                                                                                  |

## How to grade choice cards

Expose an `ask-user-question` tool, or the client's equivalent, whenever `client.choice_ui` isn't `none`.

A card passes only if:

- it uses the tool, not plain text
- it has 2–4 options
- the recommended option is first and marked
- every option shows its description
- there's no more than one card before the first build and one after it

A card asking for something the conversation already answered fails.

## Skill selection

With all Notion skills installed, check which skill gets picked. Naming the skill explicitly tests execution, not discovery.

| Request                                                  | Expected                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Help me plan our team offsite in May                     | Planner                                                                           |
| Set up the pricing page launch as a project              | Planner (or set-up-my-project, if installed, without building a second structure) |
| Break this campaign down into tasks                      | Planner                                                                           |
| What's next on the launch?                               | Planner (update mode)                                                             |
| The design review slipped a week, so update the plan     | Planner (update mode)                                                             |
| Do our weekly check-in on the offsite                    | Planner (check-in mode)                                                           |
| Give me a month of Instagram posts / I need to post more | Planner                                                                           |
| Write one Instagram caption for a latte photo            | None                                                                              |
| Make a packing list for a weekend away                   | None (answer in chat)                                                             |
| Compare three venues for the offsite                     | Research documentation                                                            |
| Turn this spec into engineering tasks                    | Spec to implementation                                                            |
| Prepare an agenda for Monday's sync                      | Meeting intelligence                                                              |
