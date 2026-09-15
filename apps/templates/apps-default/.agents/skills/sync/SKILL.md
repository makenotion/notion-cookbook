---
name: sync
description: Build, debug, or review Notion App database syncs with stable keys and resumable pagination.
user-invocable: false
---

# App database syncs

Read the installed `@notionhq/apps/sync`, `database`, `schema`, and `builder`
declarations before adapting a Worker sync. Default-export one sync directly in
`src/syncs/<key>.ts`. Apps use standalone declarations, not `worker.sync()`.
Put sync-specific helpers in `src/syncs/lib/` and shared helpers in `src/lib/`.

```ts
import { Builder } from "@notionhq/apps/builder"
import { createDatabase } from "@notionhq/apps/database"
import { Schema } from "@notionhq/apps/schema"
import { createSync } from "@notionhq/apps/sync"

const issues = createDatabase("issues", {
  schema: { Name: Schema.title(), "External ID": Schema.richText() },
})

export default createSync({
  database: issues,
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

Users attach a real database to an Apps database declaration. Do not add a
Worker managed-database option. The schema is the property map directly, not
`schema.properties`. Set `primaryKey` on the sync; it must name a title or
rich-text property. Omit it from upsert properties: the SDK supplies it from
`change.key`. Use Apps `Schema` and `Builder` values, not Notion REST property
objects. If the app already uses Notion-as-Code data sources, inspect
`createDataSourceSync` and reuse its typed data source handle.

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
