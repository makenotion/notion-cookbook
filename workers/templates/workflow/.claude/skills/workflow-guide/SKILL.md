---
name: workflow-guide
description: Reference for designing and implementing Notion Worker workflows with typed triggers, durable steps, replay-safe data flow, and idempotent side effects
user-invocable: false
---

# Workflow Guide

Use this reference whenever creating, changing, reviewing, or debugging a workflow.

## Definition Shape

A workflow is a default export from a camelCase file directly under `src/workflows/`. The filename becomes the workflow key.

```ts
import { triggers } from "@notionhq/workers/alpha/triggers";
import { createWorkflow } from "@notionhq/workers/alpha/workflow";

export default createWorkflow({
  title: "Handle page updates",
  description: "Processes pages after their content changes.",
  triggers: [triggers.notionPageUpdated()],
  handler: async (event, context) => {
    await context.step("Process update", async ({ id }) => {
      return { id, pageUrl: event.url };
    });
  },
});
```

The trigger array determines the handler event type. For multiple triggers, switch on `event.type` and handle every declared type. Prefer one workflow per cohesive behavior; combine triggers only when they genuinely share the same orchestration.

Before using a trigger or event property, inspect `@notionhq/workers/alpha/triggers` in the installed SDK. Trigger event shapes are normalized contracts and should not be inferred from a provider's raw payload.

## Step Boundaries

A step is the workflow's durable determinism boundary. Anything non-deterministic must happen inside a step, whether its return value can vary or its external effect depends on whether it runs. Only deterministic computation belongs outside steps. Non-deterministic work includes:

- network, Notion API, database, or filesystem I/O whose result matters;
- sending a message, notification, or email;
- creating or updating a record, invoking an action-style API, or performing another external side effect;
- reading the current time when it affects behavior or output;
- generating random values, UUIDs, tokens, or other non-deterministic identifiers;
- reading any mutable external state that can change between attempts.

Keep deterministic transformations of the event and previously recorded step results outside steps. An expensive deterministic computation may still use a step when checkpointing its result is useful, but expense alone does not make it non-deterministic.

One-time work still needs idempotency. An attempt can perform the external action and fail before the successful step result is recorded, causing the callback to run again. Pass the step `id` as an idempotency key when supported or use an equivalent duplicate guard.

```ts
const input = await context.step("Fetch input", () => fetchInput());
const generated = await context.step("Generate timestamp and ID", () => ({
  createdAt: new Date().toISOString(),
  id: crypto.randomUUID(),
}));

const payload = transform(input, generated);
```

Every step name must be unique within a run. For repeated operations, include a stable entity ID, a deterministic index, or both:

```ts
const records = await context.step("Fetch records", () => fetchRecords());

for (const [index, record] of records.entries()) {
  await context.step(`Process record ${index + 1} (${record.id})`, () => processRecord(record));
}
```

Prefer stable IDs when available. A collection returned by a step replays in its recorded order, so its existing indices are safe to use directly. Keep names concise and action-oriented so a reader can distinguish repeated work in run logs.

Every step result must be JSON-serializable. Return data needed later rather than depending on mutations inside the callback:

```ts
const customer = await context.step("Fetch customer", async () => {
  const response = await fetch(customerUrl);
  if (!response.ok) {
    throw new Error(`Customer request failed: ${response.status}`);
  }
  return (await response.json()) as Customer;
});

await context.step("Update page", () =>
  context.notion.pages.update({
    page_id: pageId,
    properties: toProperties(customer),
  }),
);
```

## Replay and Ordering

Completed steps may replay their saved result without invoking their callbacks. Current step identity follows call order.

- Keep calls in a stable order.
- Keep names unique and deterministic, including for calls made in loops.
- Avoid conditional step calls whose condition can differ when earlier work is replayed.
- Build repeated step calls from collections returned by earlier steps so replay preserves their order.
- Do not move a new step in front of existing steps without considering in-progress runs.
- Treat the returned value as the only durable output of a step.

Callbacks returning `void` resolve to `null`. Use an explicit serializable return value when later logic needs confirmation data.

## Idempotency

Retries can repeat work that did not reach a recorded success. Each callback receives a unique `id` for that invocation. Pass it to downstream services that support idempotency keys.

If a service has no native idempotency support, design an equivalent guard when duplicate side effects would be harmful: use a stable external identifier, look up existing state before creating it, or make the operation an upsert.

Reads can generally be retried. Writes, sends, charges, and creates require an explicit duplicate-safety decision.

## Failure Handling

Throw on failed requests and invalid required data. Include enough context to diagnose the failure without logging credentials or private payloads.

Catch errors only when the workflow can recover, translate the failure into a clearer error, or intentionally continue. Do not swallow a failure merely to let the handler finish.

## Authentication

Use `context.notion` for Notion API calls. Before calling it, ensure `NOTION_API_TOKEN` exists in `.env` for local execution and in the deployed environment. Read third-party credentials from `process.env`; never embed them in code or ask the user to paste secrets into chat.

## Verification

Run both checks after an implementation:

```shell
npm run check
npm run build
```

Review the resulting workflow for typed trigger handling, complete non-determinism boundaries, deterministic step order, serializable results, surfaced failures, and idempotent side effects.
