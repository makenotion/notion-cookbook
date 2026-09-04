# Apps workflow template guidance

## Project structure

- `src/workflows/` contains workflow definitions.
- Each direct `src/workflows/*.ts` file defines one workflow.
- The camelCase filename becomes the workflow key.
- Do not edit generated `dist/` or `.notion/` files.

## Workflow definitions

Default-export `createWorkflow(...)` from every workflow file.

```ts
import { triggers } from "@notionhq/apps/triggers"
import { createWorkflow } from "@notionhq/apps/workflow"

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

- Use trigger creators from `@notionhq/apps/triggers`.
- Let the trigger list infer the event type.
- Check installed SDK declarations before using a trigger or event field.
- Narrow `event.type` before reading fields when a workflow has multiple
  trigger types.

## Durable steps

`context.step(name, callback)` is the workflow durability boundary.

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
- Let unexpected failures throw so Notion can retry the workflow.

An external write can succeed before a step result is saved. Use idempotency
keys, an upsert, or a duplicate check when retries could cause harm.

## Notion API access

`context.notion` provides the Notion SDK client. Set `NOTION_API_TOKEN` in
`.env` for local execution before a workflow makes a Notion API request. Never
commit or log credentials.

## Calendar workflows

For calendar reads, meeting times, rooms, event writes, or scheduling links,
read `.agents/skills/calendar/SKILL.md` from the App root before writing the
workflow.

## Commands

Run these commands after changing a workflow:

```shell
npm run check
npm run build
```

Enable the Apps experiment and deploy with:

```shell
ntn experiments enable apps
ntn apps deploy
```
