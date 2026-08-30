# Notion Workflows template

> [!WARNING]
>
> Workflows are an early alpha feature. The SDK can make breaking changes.

This template starts a Worker that runs durable automation steps after a
configured trigger fires. The included `sayHello` Workflow runs on a recurring
schedule.

## Prerequisites

- Access to the Workflows alpha.
- Node.js 22 or newer and npm 10.9.2 or newer.
- The Notion CLI.

## Quick start

Create the Worker from this template:

```shell
ntn workers new my-workflow --template workflow
cd my-workflow
npm run check
npm run build
ntn login
ntn workers deploy --name my-workflow
```

Open the deployed Worker in the [Developer Portal](https://app.notion.com/developers/workers).
Configure its trigger, then save the Workflow before testing it.

## Project structure

```text
src/workflows/
  sayHello.ts  Example recurring Workflow
```

Each TypeScript file directly inside `src/workflows/` defines one Workflow.
Its camelCase filename becomes its Workflow key.

## Extend the template

1. Copy `src/workflows/sayHello.ts` to a camelCase filename.
2. Set a descriptive `name`, description, and trigger list.
3. Put each read, write, API request, time value, random value, or external
   effect inside an awaited `context.step(...)` call.
4. Give every step a stable display name. For a repeated step, keep the name
   constant and pass a stable composite key such as
   `{ key: ["process-page", page.id] }` instead of interpolating the item into
   the name. Return any later input from the step.
5. Pass the step `id` as an idempotency key when the downstream service
   supports one.
6. Run `npm run check` and `npm run build` before deployment.

Completed steps replay their saved results after a retry. A side effect can
still run more than once if it succeeds before its result is recorded. Make
writes idempotent or use an equivalent duplicate guard.

Use `context.notion` for Notion API calls. Add `NOTION_API_TOKEN` to `.env`
for local development, then run `ntn workers env push` after deployment. Do
not commit `.env` or credentials.

## Verification

Run these commands from this directory:

```shell
npm install
npm run check
npm run build
```

After deployment, configure the trigger in the Developer Portal and send one
test event. Use `ntn workers runs list` and `ntn workers runs logs <run-id>` to
inspect the result.

## Learn more

- [Notion Workers documentation](https://developers.notion.com/docs/workers)
- [Contribute to this cookbook](../../../CONTRIBUTING.md)
