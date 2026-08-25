# Notion Apps templates

Notion Apps are server-side extensions built with the workflow-only
`@notionhq/apps` SDK. Each direct child of [`templates/`](templates/) is an
independent project that can be copied, built, and deployed on its own.

> [!WARNING]
>
> Notion Apps and the Apps SDK are early alpha features and can introduce
> breaking changes.

## Templates

| App                                 | What it demonstrates                                  |
| ----------------------------------- | ----------------------------------------------------- |
| [Workflow app](templates/workflow/) | A recurring workflow with a replay-safe durable step. |

## Quick start

```shell
cd apps/templates/workflow
npm install
npm run check
npm run build
ntn experiments enable apps
ntn login
ntn apps deploy --name my-workflow-app
```

Apps require Node.js 26 or newer. The `ntn apps` command is experimental and
must be enabled before deployment.

## Contributing

Add workflow-only Apps under `apps/templates/<name>/` and follow the recipe
contract in [`CONTRIBUTING.md`](../CONTRIBUTING.md).
