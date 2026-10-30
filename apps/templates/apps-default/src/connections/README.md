# Shared app connections

Default-export one connection per TypeScript file here when the app needs an
external service. Use `connections.calendar(...)`, `connections.mail(...)`,
`connections.slack(...)`, or another provider factory from `@notionhq/apps`. Default-import them into workflows and call them directly
inside handlers. All workflows in one installation share setup.

Read the separate `.agents/skills/connections/SKILL.md` loader from the app root.
No external connection is required by the default scaffold.
