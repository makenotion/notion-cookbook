# Example: a launch that slipped, then a weekly check-in

A fictional example of the "update a plan" and "check in" modes. The plan already exists in the person's Notion Projects.

## Starting state

**🚀 Saved views launch** is a project row in **Projects**, with 9 tasks in the shared **Tasks** database. The launch is targeted for Nov 19. Tasks include:

| Task                  | Status      | Owner | Due    | Blocked by            |
| --------------------- | ----------- | ----- | ------ | --------------------- |
| Design review         | In progress | Lena  | Nov 5  | —                     |
| Build onboarding tour | To do       | Omar  | Nov 12 | Design review         |
| Help article          | Drafting    | Kai   | Nov 14 | —                     |
| Launch announcement   | Drafting    | Kai   | Nov 17 | Design review         |
| Go/no-go check        | To do       | Lena  | Nov 18 | Build onboarding tour |

## The request

> The design review slipped a week, to Nov 12. Update the plan.

## What the agent does

1. Finds the existing project and doesn't create a new one. It moves Design review to Nov 12.
2. Works out the knock-on effects: the onboarding tour can't finish by Nov 12 and needs about a week after the review, so the go/no-go check on Nov 18 is now at risk. The help article isn't affected.
3. The trade-off belongs to the person, so it shows **card 3** (single-select):
   > **The design review moved to Nov 12. What should give?**
   >
   > 1. **Move the launch to Nov 26 (Recommended):** keeps the full scope; the tour, the announcement and the go/no-go check move a week.
   > 2. **Keep Nov 19 and cut the onboarding tour:** ships on time; the tour follows in a later release.
4. The person picks 1. The agent moves the dependent tasks and logs the decision in the Status section:
   > **Nov 3 · Launch moved to Nov 26.** The design review slipped a week; we kept the full scope. Decided by you.
5. It answers "what's next": "Lena: design review by Nov 12. Kai: the help article is still due Nov 14."

## A week later: "Do our weekly check-in on the launch"

The agent compares now with the last check-in (Nov 3), using dates and statuses, not edit times:

> **Check-in · Nov 10**
>
> - **Moved:** the help article is done (finished Nov 9). The announcement is in review.
> - **Stuck:** the onboarding tour has no owner since Omar's switch; it needs one by Nov 13.
> - **Next:** Lena finishes the design review by Nov 12. The tour needs an owner. Kai finalizes the announcement by Nov 24.
> - **Decision needed:** who owns the tour? (shown as a choice card listing the people on the project)

The check-in is written at the top of the Status section. Then the agent offers, once: "Want this as a recurring Monday check-in on your calendar, with a meeting note linked to the launch?" If the person says yes, it creates the event and asks before inviting anyone.

Not done: no task was marked done just because it was edited, no new project or tracker was created, and the old Nov 19 date stays in the decision log.
