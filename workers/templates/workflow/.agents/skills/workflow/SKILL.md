---
name: workflow
description: Scaffold a Notion Worker Workflow with typed triggers and replay-safe durable steps.
user-invocable: true
disable-model-invocation: true
---

# Workflow

Use this skill to add a Workflow to this template.

1. Read `AGENTS.md` and the existing files in `src/workflows/`.
2. Inspect the installed Workflow and trigger declarations.
3. Choose the trigger, outcome, step boundaries, and required configuration.
4. Create one camelCase file directly in `src/workflows/`.
5. Default-export `createWorkflow(...)` and use typed trigger creators.
6. Put all non-deterministic work in awaited `context.step(...)` calls.
7. Give each step a unique, stable name and return JSON-safe later inputs.
8. Use the step `id` as an idempotency key when supported.
9. Run `npm run check` and `npm run build`.

Do not write credentials. Add only environment variable names and safe
placeholders to `.env.example` when configuration is required.
