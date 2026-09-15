# Notion Apps templates

Notion Apps are extensions built with the
`@notionhq/apps` SDK. Each direct child of [`templates/`](templates/) is an
independent project that can be copied, built, and deployed on its own.

> [!WARNING]
>
> Notion Apps and the Apps SDK are early alpha features and can introduce
> breaking changes.

## Templates

| App                                    | What it demonstrates                                                      |
| -------------------------------------- | ------------------------------------------------------------------------- |
| [Default app](templates/apps-default/) | A recurring workflow with a durable step and an interactive custom block. |

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

The SDK supports workflows, database syncs, and custom blocks. Canonical coding
guidance lives in [agents/](agents/); run `npm run agents:sync` from the repository
root after changing it.
