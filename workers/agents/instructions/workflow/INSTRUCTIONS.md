# Workflow template guidance

## Project structure

- `src/workflows/` contains Workflow definitions.
- Each direct `src/workflows/*.ts` file defines one Workflow.
- The camelCase file name becomes the Workflow key.
- Do not edit generated `dist/` or `.notion/` files.

## Workflow definitions

Default-export `createWorkflow(...)` from every Workflow file.

```ts
import { triggers } from "@notionhq/workers/alpha/triggers"
import { createWorkflow } from "@notionhq/workers/alpha/workflow"

export default createWorkflow({
  name: "Process new pages",
  description: "Processes pages after they are created.",
  triggers: [triggers.notionPageCreated()],
  handler: async (event, context) => {
    await context.step("Process page", async ({ id }) => {
      console.log(`Process ${event.url} with idempotency key ${id}`)
    })
  },
})
```

- Use trigger creators from `@notionhq/workers/alpha/triggers`.
- Let the trigger list infer the event type.
- Check installed SDK declarations before using a trigger or event field.
- Narrow `event.type` before reading trigger-specific fields.

## Durable steps

`context.step(name, callback)` is the Workflow durability boundary.

- Await every step.
- Put all relevant I/O inside a step.
- Put writes, messages, API calls, time reads, and random IDs inside a step.
- Keep only deterministic transforms outside steps.
- Keep step order and names stable across retries.
- Treat the step name as a stable display label, not a place to interpolate an
  item ID or loop index.
- For repeated steps, pass a stable composite key as the second argument so
  each invocation has a unique replay identity:

  ```ts
  for (const page of pages) {
    await context.step(
      "Process page",
      { key: ["process-page", page.id] },
      async ({ id }) => processPage(page, { idempotencyKey: id })
    )
  }
  ```

- Keep every key stable across retries and unique within one workflow run.
- Return JSON-serializable values that later code needs.
- Pass the callback `id` to services that accept idempotency keys.
- Let unexpected failures throw so Notion can retry the Workflow.

An external write can succeed before a step result is saved. Use idempotency
keys, an upsert, or a duplicate check when retries could cause harm.

## Notion API access

`context.notion` provides the Notion SDK client. Set `NOTION_API_TOKEN` in
`.env` before a Workflow makes a Notion API request. Push environment values
after deployment with `ntn workers env push`. Never commit or log credentials.

## Commands

Run these commands after changing a Workflow:

```shell
npm run check
npm run build
```

Deploy with `ntn workers deploy`, then configure the trigger in the Developer
Portal. Inspect completed and failed runs with `ntn workers runs list` and
`ntn workers runs logs <run-id>`.
