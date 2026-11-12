# Notion plugin for Gemini

Connects Gemini to the
[Notion MCP server](https://developers.notion.com/docs/notion-mcp) and adds the
[MCP client skills](../../skills/mcp-clients/). The first Notion tool call asks
you to authorize your workspace.

## What's included

| File                         | Purpose                                                   |
| ---------------------------- | --------------------------------------------------------- |
| `.gemini-plugin/plugin.json` | Manifest. Points to `skills/` and `.mcp.json`             |
| `.mcp.json`                  | Notion MCP server at `https://mcp.notion.com/mcp` (OAuth) |
| `skills/`                    | Generated from `skills/mcp-clients/`. Do not edit.        |
| `CHANGELOG.md`, `LICENSE`    | Release notes and MIT license                             |

## Example prompts

Find and read:

- "Find our latest roadmap doc in Notion and summarize the top priorities."
- "What did we decide about the pricing change? Check Notion."
- "Research what our Notion docs say about SSO and write a cited brief."
- "Compare the two onboarding proposals in Notion and list the tradeoffs."
- "Which tasks in my Notion projects are overdue or blocked?"
- "Summarize what changed in the Atlas project in Notion this week."
- "Pull the action items from last Tuesday's design review notes."
- "Find the on-call runbook in Notion and walk me through the first steps."
- "What open questions are left in the checkout redesign spec?"
- "List the customer feature requests in Notion with no owner yet."
- "Show me everything in Notion related to the Q3 launch."
- "Explain how our deploy process works, based on the engineering wiki."

Create and update:

- "Set up Notion so you can use my workspace as context."
- "Turn the checkout redesign spec in Notion into an implementation plan with tasks."
- "Write this week's status update for the Atlas project from Notion."
- "Prep an agenda and pre-read in Notion for tomorrow's roadmap review."
- "Save the pricing decision we just made as a decision record in Notion."
- "Turn this conversation into a how-to guide in our Notion wiki."
- "Set up a Notion tracker for customer feature requests with owners and status."
- "Set up a Notion project home for the mobile onboarding redesign."
- "Plan our spring launch campaign in Notion with a brief and content calendar."
- "Create a team handbook in Notion from our onboarding docs and process notes."
- "Build an engineering wiki in Notion from our architecture docs and runbooks."
- "Organize my fall semester in Notion from these syllabi."
- "Add the follow-ups from this meeting as tasks on the project in Notion."
- "Mark the login bug task as done and note the fix in Notion."

## Maintain

Edit skills in [`skills/mcp-clients/`](../../skills/mcp-clients/), then run
`npm run plugins:build` from the repository root and commit the result. CI runs
`npm run plugins:check` and fails when `skills/` is out of date. Add a
`CHANGELOG.md` entry and bump `version` in `.gemini-plugin/plugin.json` for
each release.
