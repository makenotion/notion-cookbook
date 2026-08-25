---
name: workflow
description: Scaffold a Notion App workflow with typed triggers and replay-safe durable steps.
user-invocable: true
disable-model-invocation: true
---

# Workflow

Use this skill to add a workflow to this template.

1. Read `AGENTS.md` and the existing files in `src/workflows/`.
2. Inspect the installed workflow and trigger declarations.
3. Choose the trigger, outcome, step boundaries, and required configuration.
4. Create one camelCase file directly in `src/workflows/`.
5. Default-export `createWorkflow(...)` and use typed trigger creators.
6. Put all non-deterministic work in awaited `context.step(...)` calls.
7. Give each step a stable display name. For repeated steps, keep the name
   constant and pass a stable, unique composite `key`, such as
   `{ key: ["process-page", page.id] }`.
8. Return JSON-safe values needed by later steps.
9. Use the step `id` as an idempotency key when supported.
10. Run `npm run check` and `npm run build`.

Do not write credentials. Add only environment variable names and safe
placeholders to `.env.example` when configuration is required.
