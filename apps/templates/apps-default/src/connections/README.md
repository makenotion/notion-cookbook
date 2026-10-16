# Shared app connections

Add named `connection({ type: ... })` exports in TypeScript files here when the
app needs an external service. Import them into workflows and call them directly
inside handlers. All workflows in one installation share setup.

Read the separate `.agents/skills/connections/SKILL.md` loader from the app root.
No external connection is required by the default scaffold.
