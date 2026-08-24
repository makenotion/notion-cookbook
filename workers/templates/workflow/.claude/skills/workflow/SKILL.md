---
name: workflow
description: Scaffold a Notion Worker workflow by choosing typed triggers, designing durable steps, and generating replay-safe TypeScript
user-invocable: true
disable-model-invocation: true
allowed-tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"]
---

## Instructions

Help the user create a workflow from intent through verified code.

Before editing:

1. Read `.agents/skills/workflow-guide/SKILL.md` completely.
2. Read existing files under `src/workflows/` and nearby shared modules.
3. Inspect the installed declarations for `@notionhq/workers/alpha/triggers` and `@notionhq/workers/alpha/workflow` so the implementation matches the installed SDK.

Then determine:

- what event should start the workflow;
- what outcome the workflow should produce;
- which I/O, mutable external state, time generation, randomness, generated IDs, and one-time actions are required;
- which environment variables are required;
- how each side effect will be made safe to retry.

Recommend a trigger and a short ordered list of step boundaries. Ask a question only when a missing choice would materially change the behavior or safety of the workflow.

Create a camelCase file directly under `src/workflows/`. Default-export `createWorkflow(...)`, use trigger creators instead of hand-written trigger objects, and let the trigger array infer the handler event type.

Anything non-deterministic must happen inside an awaited `context.step(...)` call. This applies when either the result can vary or the external effect depends on whether the operation runs. It includes any I/O whose result matters, mutable external state, current time, randomness, generated identifiers, messages, notifications, creates, updates, and action-style calls. Only deterministic transformations of recorded values belong outside steps. Give every step a unique, deterministic name; for repeated work, append a stable entity ID or an index from a collection returned by an earlier step. Use that collection's recorded order directly. Keep step order deterministic, return JSON-serializable data needed by later code, pass the step `id` to retry-sensitive downstream operations when supported, validate response status, and let unrecoverable failures propagate.

Do not write secrets. Add environment variable names to `.env.example` when that file exists, and tell the user which values they must provide themselves.

Finish by running:

```shell
npm run check
npm run build
```

Fix any failures caused by the implementation. Summarize the workflow key, trigger, steps, required configuration, retry-safety strategy, and verification performed.
