# Notion Apps templates

Notion Apps are extensions built with the
`@notionhq/apps` SDK. Each direct child of [`templates/`](templates/) is an
independent project that can be copied, built, and deployed on its own.

> [!WARNING]
>
> Notion Apps and the Apps SDK are early alpha features and can introduce
> breaking changes.

## Templates

| App                                             | What it demonstrates                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| [Default app](templates/apps-default/)          | A recurring workflow with a durable step and an interactive custom block. |
| [Perfect Meetings](templates/perfect-meetings/) | Calendar connection, deterministic triggers and agentic research          |
| [Statsig Rollout](templates/statsig-rollout/)   | Database-triggered workflow that calls an external API with retries       |

## Quick start

```shell
cd apps/templates/apps-default
npm install
npm run check
npm run build
ntn experiments enable apps
ntn login
ntn apps deploy --name my-workflow-app
```

Apps require Node.js 26 or newer. The `ntn apps` command is experimental and
must be enabled before deployment.

Apps are a private alpha and are not currently open for general contribution.

## Calendar targets

Declare one Calendar connection per workflow. Give each purpose a named target
with a description, needed permissions, and an explicit `multiple` setting.
Connect accounts during setup, then choose calendars under each target.
Connecting an account alone does not approve access to its calendars.

Calendar event triggers require a target from the trigger callback's
`connections`. Reads require a target from `context.connections`. Reuse the same
target when the trigger and the read should use the same calendars; setup shows
one picker and lists the triggers that use it.

See [Perfect Meetings' Calendar workflow](templates/perfect-meetings/src/workflows/calendarIngest.ts)
for all three Calendar event triggers sharing a read target. This example needs
the target-aware Calendar trigger SDK and matching server/setup UI; older SDKs
that accept only `connectionKey` for Calendar triggers cannot build it.

The SDK supports workflows, database syncs, and custom blocks. The full coding
guidance ships with `@notionhq/apps`. Template skill loaders live in
[agents/](agents/); run `npm run agents:sync` from the repository root after
changing them.
