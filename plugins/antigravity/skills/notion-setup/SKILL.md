---
name: notion-setup
description: A guided setup flow to get the most out of Notion that is recommended for all users who install the Notion MCP.
---

Read https://developers.notion.com/prompts/setup and follow its setup, authorization,
and destination checks. Reuse the user's existing approved setup.

If the user has no Notion account or workspace yet, the Notion connection's sign-in
page creates one; continue setup once the connection reaches it.

When an installed Sync Memory skill supports this host's local memory source,
pin the destination with its `use-workspace` command, and use its `preview`,
`sync`, and `verify` commands for approved memory imports. Let its deterministic command copy the Markdown; keep the online guide's
other setup steps separate. If Sync Memory is unavailable or does not support the
source, follow the online guide's supported memory workflow. Sync Memory runs only
on a desktop host with local execution; web hosts use the online guide's workflow.

For recurring imports handled by Sync Memory, use its **Recurring sync** section
to prepare the task during this setup. After the user approves the schedule, sources, destination,
and notifications, create or update the task with the host's native scheduler.
Use a local task that invokes the installed Sync Memory skill.
Reuse the matching existing task instead of creating a second memory-import loop.
Replace its memory-import action with `sync`; preserve its other approved actions
and notification settings. Run the sync command
once before enabling the task, then read back the saved schedule and prompt.

Installation and one-time import approval do not authorize recurring work.
If the host cannot schedule local execution, report that limitation and leave
manual Sync Memory available. This workflow adds no lifecycle hooks or OS service.
