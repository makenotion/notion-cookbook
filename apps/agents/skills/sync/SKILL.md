---
name: sync
description: Build, debug, or review Notion App database syncs with stable keys and resumable pagination.
user-invocable: false
---

# App database syncs

Read the installed `@notionhq/apps/sync`, `notion-as-code`, and `builder`
declarations before adapting a Worker sync. Default-export one sync directly in
`src/syncs/<key>.ts`. Apps use standalone declarations, not `worker.sync()`.
Put sync-specific helpers in `src/syncs/lib/` and shared helpers in `src/lib/`.

## Choose the database source

Prefer Notion as Code for the sync's database when Apps Notion as Code supports the required schema.
Do not choose manual database setup or a separate attached-database declaration
when Notion as Code can provide the same resource.

For a database the App creates, declare and provision it with
`Notion.database(...)` and `Notion.sync({ dataSource, ... })`.
Read the [Notion as Code skill](../notion-as-code/SKILL.md) for that path,
including declaration discovery and the supported schema types.

This example declares an Issues database and syncs into its data source:

```ts
import * as Notion from "@notionhq/apps"
import { Builder } from "@notionhq/apps/builder"

const issues = Notion.database({
  resourceId: "issues-db",
  name: "Issues",
  dataSources: [
    {
      resourceId: "issues-source",
      name: "Issues",
      properties: [
        { resourceId: "issue-name", name: "Name", type: "title" },
        { resourceId: "issue-id", name: "External ID", type: "text" },
      ],
    },
  ],
})

export default Notion.sync({
  dataSource: issues.dataSources["issues-source"],
  primaryKey: "External ID",
  mode: "incremental",
  handler: async () => ({
    changes: [
      {
        type: "upsert",
        key: "example-123",
        properties: { Name: Builder.title("Example issue") },
      },
    ],
    hasMore: false,
  }),
})
```

Set `primaryKey` on the sync; it names a title or text property by its display
name. Omit it from upsert properties: the SDK supplies it from `change.key`.
Use Apps `Builder` values for sync results. Keep resource IDs stable and reuse
the declared data source handle. Shared declarations can live in
`src/lib/resources.ts`, imported by the sync.

This skill covers only syncs backed by Notion as Code data sources. If the user
asks to attach an existing database, explain that this recipe does not cover
that setup and clarify the next step. Do not silently create a replacement
database.

## Pagination and reconciliation

The handler receives `(state, context)` and returns `changes`, `hasMore`, and
`nextState`. State can be undefined initially. Persist a serializable cursor
and advance it only after successfully processing the corresponding page.
Return `hasMore: true` while pages remain; an empty filtered page is not proof
that the upstream listing ended. Keep record keys deterministic across pages
and runs. Throw on failed requests instead of emitting a false empty success.

Choose and document replace versus incremental behavior explicitly. Replace
requires a complete snapshot; incremental requires explicit deletion handling
when upstream records disappear. Test multiple pages, empty pages with a next
cursor, retrying the same cursor, and deletion handling offline.

The context supplies `notion`, not workflow steps or connection clients.
Configure required external credentials separately using names and safe
placeholders in `.env.example`; do not copy Worker auth registration.

## Review and verify

Check stable keys, schema/value compatibility, cursor progress and exhaustion,
partial failures, and whether the documented mode matches the emitted changes.
Report findings with file, line, impact, and fix. Run the app's offline tests,
`npm run check`, and `npm run build`. Live execution can change database rows;
use it only as part of the requested live task.
