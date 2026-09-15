---
name: workflow
description: Build or review Notion App workflows for typed triggers, durable replay-safe steps, and idempotent effects.
user-invocable: true
disable-model-invocation: true
---

# Workflow

Use this skill to add or review a workflow in this template.

## Build or change a workflow

1. Read `AGENTS.md` and the existing files in `src/workflows/`.
2. Inspect the installed workflow and trigger declarations.
3. Choose the trigger, outcome, step boundaries, and required configuration.
4. Create one camelCase file directly in `src/workflows/`.
5. Default-export `Notion.workflow(...)` and use typed trigger creators.
6. Put all non-deterministic work in awaited `context.step(...)` calls.
7. Give each step a stable display name. For repeated steps, keep the name
   constant and pass a stable, unique composite `key`, such as
   `{ key: ["process-page", page.id] }`.
8. Return JSON-safe values needed by later steps.
9. Use the step `id` as an idempotency key when supported.
10. Run `npm run check` and `npm run build`.

Each direct `src/workflows/*.ts` file must default-export `Notion.workflow(...)`.
The camelCase file name becomes its workflow key.
Keep workflow-specific helpers in `src/workflows/lib/` and shared helpers in
`src/lib/`; direct children of `src/workflows/` are discovered as workflows.

For provider triggers, follow [trigger connection binding](../connections/SKILL.md#bind-triggers-to-connections).
Use the typed trigger callback to check `connectionKey` against the declared
provider connections.

Use a step for every value that can change and every external effect: network
and Notion API calls, mutable state reads, timestamps, random values, generated
IDs, messages, creates, and updates. Keep deterministic transforms of the event
and completed step results outside a step.

Completed steps replay saved results. Do not rely on in-memory mutations inside
a step. Return the values required by later code. Keep calls in a stable order
and give every step a stable display name. The name is the replay key by
default. For a repeated step, do not interpolate an item ID or loop index into
the name; pass a stable composite key instead:

```ts
await context.step(
  "Process page",
  { key: ["process-page", page.id] },
  async ({ id }) => processPage(page, { idempotencyKey: id })
)
```

Keys must be stable across retries and unique within one workflow run.

An external effect can succeed before its step result is saved. Pass the
callback `id` as an idempotency key when supported; otherwise use a stable
external ID, upsert, or duplicate check.

Do not write credentials. Add only environment variable names and safe
placeholders to `.env.example` when configuration is required. Return only
JSON-serializable step values, throw on failed requests and missing required
configuration, and do not log secrets or private payloads.

## Resources created with the App

Use [Notion as Code](../notion-as-code/SKILL.md) for pages and databases that
should be created during deployment. Prefer it over equivalent manual setup
or API calls that create the App's resources. Use runtime API calls for dynamic
data changes, not as a substitute for supported Notion as Code setup.
Keep declarations at module scope in
an imported helper. For example, declare a guide page in `src/lib/resources.ts`:

```ts
import * as Notion from "@notionhq/apps"

export const guide = Notion.page({
  resourceId: "workflow-guide",
  content: "# Workflow guide\nThis App runs a scheduled workflow.",
})
```

Import the module from `src/workflows/sayHello.ts` so the build records it:

```ts
import "../lib/resources"
import * as Notion from "@notionhq/apps"
import { triggers } from "@notionhq/apps/triggers"

export default Notion.workflow({
  name: "Say Hello",
  description: "Says hello on a recurring schedule.",
  triggers: [triggers.scheduled()],
  handler: async (_event, context) => {
    await context.step("Say hello", () => {
      console.log("Hello from your workflow!")
    })
  },
})
```

The page is provisioned during deployment, not on every workflow run.
Database declarations follow the same import pattern; see the
[sync example](../sync/SKILL.md#choose-the-database-source) for using a Notion as Code
data source in a sync. Notion as Code resource IDs are declaration identities, not live
Notion UUIDs to pass to `context.notion`. Runtime API calls still belong in
durable steps and need actual resolved Notion IDs.

## Review a workflow

Review every file in `src/workflows/` and the modules it calls. Report each
finding with its file, line, impact, and fix. Treat these as errors:

1. A workflow is not a direct file or does not default-export `Notion.workflow`.
2. Trigger-specific event fields are used without type narrowing.
3. Non-deterministic work occurs outside an awaited step.
4. Step order or names can change between retries.
5. A step result is not JSON-serializable, or later code needs an in-memory mutation.
6. A retry-sensitive write lacks an idempotency key or duplicate guard.
7. External failures are ignored, or credentials are hard-coded or logged.
8. An explicit trigger connection key is undeclared, belongs to the wrong
   provider, or repeats the same trigger-type/key pair.

Run `npm run check` and `npm run build` when dependencies are installed.
