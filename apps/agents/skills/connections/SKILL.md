---
name: connections
description: Declare and use shared app-level Calendar, Mail, Slack, and OAuth connections in Notion Apps.
user-invocable: false
---

# App connections

Keep named declarations in `src/connections/`, separate from workflows.
Use `connection({ type: ... })`, flat Calendar targets, and direct provider calls.
The SDK also supports a continuous `src/app.ts` with several named workflows.

Before creating, modifying, or troubleshooting connection code, read
`node_modules/@notionhq/apps/skills/connections/SKILL.md`.
Resolve this path relative to the App project root.
Follow the instructions in that file.

If the file is missing, install the project dependencies.
If it remains missing, update `@notionhq/apps` to a release that includes the skill.
Do not continue with connection changes until you can read the SDK skill.
