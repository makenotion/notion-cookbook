# Default Notion App template

> [!WARNING]
>
> Notion Apps and the Apps SDK are early alpha features and can introduce
> breaking changes.

This template builds a workflow and custom block Notion App with the
[`@notionhq/apps`](https://www.npmjs.com/package/@notionhq/apps) SDK. The
included `sayHello` workflow runs from a recurring trigger and demonstrates a
replay-safe durable step. The hello block demonstrates an interactive browser UI.

## Prerequisites

- Access to the Notion Apps alpha.
- Node.js 26 or newer.
- A version of the Notion CLI with the experimental `apps` command.

## Quick start

```shell
cd apps/templates/apps-default
npm install
npm run check
npm run build
```

The build discovers workflow files by convention and produces:

```text
dist/
  manifest.json  App metadata, workflows, and block declarations
  worker.js      Deployable workflow bundle
```

## Project structure

```text
.agents/       Coding-agent guidance and skills
src/workflows/
  sayHello.ts  Example recurring workflow
src/customBlocks/
  hello.ts     Browser project declaration
blocks/hello/  Browser source, Vite config, and separate browser tsconfig
```

Every TypeScript file directly inside `src/workflows/` defines one workflow.
The camelCase filename becomes its workflow key, and the file must default
export `createWorkflow(...)`.

## Extend the template

1. Copy `src/workflows/sayHello.ts` to a camelCase filename.
2. Set a descriptive `name`, `description`, and trigger list.
3. Put each read, write, API request, time value, random value, or external
   effect inside an awaited `context.step(...)` call.
4. Give every step a stable display name. For a repeated step, keep the name
   constant and pass a stable composite key such as
   `{ key: ["process-page", page.id] }` instead of interpolating the item into
   the name. Return any value needed by later steps.
5. Pass the step `id` as an idempotency key when the downstream service
   supports one.
6. Run `npm run check` and `npm run build`.

Completed steps replay their saved results after a retry. An external effect
can still happen more than once if it succeeds before the step result is
recorded, so make writes idempotent or add a duplicate guard.

Use `context.notion` for Notion API calls. Set `NOTION_API_TOKEN` in `.env` for
local execution and never commit credentials.

For workflows using providers, read the [connections skill](.agents/skills/connections/SKILL.md).
It covers typed provider clients, trigger connection keys, and safe retries.

Agent guidance is generated from [apps/agents](../../agents/). Edit that
canonical source and run `npm run agents:sync` from the repository root.
Keep workflow-specific helpers in `src/workflows/lib/` and shared helpers in
`src/lib/`.

## Deploy the app

Apps commands are currently hidden behind a Notion CLI experiment:

```shell
ntn experiments enable apps
ntn login
ntn apps deploy --name my-workflow-app
```

On later deployments from the same project, omit `--name` to update the
existing app.

## Verification

Run these commands from this directory:

```shell
npm install
npm run check
npm run build
```

The example needs no credentials for these offline checks.

## Learn more

- [`@notionhq/apps` on npm](https://www.npmjs.com/package/@notionhq/apps)
