---
name: workflow-guide
description: Reference for typed triggers, durable steps, replay-safe data flow, and idempotent workflow effects.
user-invocable: false
---

# Workflow guide

Each direct `src/workflows/*.ts` file must default-export `createWorkflow(...)`.
The file name becomes its workflow key.

Use a step for every result that can change and every external effect. This
includes network and Notion API calls, mutable state reads, timestamps, random
values, generated IDs, messages, creates, and updates. Keep deterministic
transforms of the event and completed step results outside a step.

Completed steps can replay saved results. Do not rely on in-memory mutations
inside a step. Return the values required by later code. Keep calls in a stable
order and give every step a stable, unique name.

Retries can repeat an external effect when it succeeds before its step result
is saved. Pass the callback `id` as an idempotency key. Use a stable external
ID, an upsert, or a duplicate check when the service lacks native support.

Return JSON-serializable values. Throw on failed requests and missing required
configuration. Do not log secrets or private payloads.
