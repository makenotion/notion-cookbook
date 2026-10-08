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

## Shared connections

Declare connections once in `src/connections/*.ts`, then import them in each
workflow. Use `connection({ type: "calendar", ... })` or
`connection({ type: "mail" })` instead of workflow-local connection declarations.
Calendar targets are flat properties, such as `calendar.meetings`.

An installation configures each connection and its targets once. Every workflow
in that App uses that saved setup. Accounts are not shared between installations.

See [Perfect Meetings' shared Calendar connection](templates/perfect-meetings/src/connections/calendar.ts)
and its [Calendar workflow](templates/perfect-meetings/src/workflows/calendarIngest.ts).
This example requires the app-level connections SDK and matching server/setup UI.
Older SDKs with workflow-local connections cannot build it.
