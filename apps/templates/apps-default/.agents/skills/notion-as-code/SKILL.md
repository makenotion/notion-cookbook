---
name: notion-as-code
description: Declare Notion pages, databases, teamspaces, and custom agents in an App, including data sources used by syncs.
user-invocable: false
---

# Notion as Code for Apps

Prefer Notion as Code whenever it supports the requested resource setup. Use declarations
for pages, databases, teamspaces, and custom agents instead of equivalent
manual setup or runtime creation calls. Respect explicit user choices and
existing resource attachments; use other methods for unsupported operations
or runtime data changes.

Import the resource creators you use, such as
`import { database, page } from "@notionhq/apps"`. These functions declare
resources for deployment; they do not make Notion API requests when called.
Use `context.notion` for runtime API operations instead.

Put shared declarations in `src/lib/`, or capability-specific declarations in
a directory such as `src/syncs/lib/`. Import them from a workflow or sync
module so the build's metadata evaluation reaches them. An unimported resource
file is not discovered automatically. Declare resources at module scope, not
inside handlers or durable steps. Module evaluation must work without
credentials or network access.

## Where declarations are picked up

The Apps build discovers direct `.ts` children of `src/workflows/` and
`src/syncs/`, then evaluates their imports with the Notion as Code recorder active.
Pages, databases, data sources, teamspaces, and custom agents all follow this
same rule. Their resource type does not determine their file location.

```text
src/
  lib/
    resources.ts          Shared page/database declarations
  syncs/
    issues.ts             Default-exported sync; imports ../lib/resources
    lib/
      issueSchema.ts      Sync-specific helper; must be imported
  workflows/
    notify.ts             Default-exported workflow
```

For example, export a database handle from `src/lib/resources.ts` and import it
in `src/syncs/issues.ts` for `sync`. A page-only declaration
module can be loaded with a side-effect import such as
`import "../lib/pages"` from a workflow or sync. Keep those imports at module
scope so build evaluation runs the declarations.

There is no automatically scanned `src/pages/`, `src/databases/`, or Notion as Code
entrypoint. Helpers under `src/syncs/lib/` are not discovered on their own.
Every direct file in a capability directory must still default-export that
capability, so do not put a resource-only file there. Imports reached only
through `src/customBlocks/` or browser code do not enter the Notion as Code recording
phase. An App containing only unimported resource declarations is not a
standalone Notion as Code project and has no discovered capabilities.

## Declare resources

Read the installed Notion as Code types before choosing fields. The Apps
root exports support:

- `teamspace({ resourceId, name, accessLevel })`, with `addPage` and
  `addDatabase` on the returned handle.
- `page({ resourceId, parent?, properties?, content? })`, with
  `addPage` and `addDatabase` for children.
- `database({ resourceId, parent?, name?, dataSources? })`, returning
  data source handles indexed by their resource IDs. A data source's
  `addPage` declares a row; the database handle also exposes `addView`.
- `customAgent({ resourceId, name, instructions?, sharedResources? })`.
  Shared resources are declared resource IDs; inspect the installed types
  before specifying models or triggers.

Keep resource IDs stable across builds. They identify declarations, not live
Notion UUIDs. Avoid the reserved `__notion_apps_` prefix. Explicit parents
use `{ type: "resourceId", resourceId: parent.resourceId }`; child helpers set
this reference for you. Pages and databases without a parent default to private
top-level resources in the Apps workspace.

Several fields, including views, covers, page layouts, and custom-agent
triggers, still have incomplete types. A field typed as `unknown` is not proof
that any payload is supported. Check implementation and examples before using
it; do not assume parity with other Notion as Code packages.

The Apps SDK exposes a subset of Notion as Code. Data sources are nested inside
`database({ dataSources: [...] })`, not declared by a separate
`dataSource` function. It has no `space` workspace declaration:
Apps deployment rejects workspace creation or changes and supplies the App's
workspace binding itself. Value helpers and types stay on their existing
subpaths. For example, import `{ notion }` from `@notionhq/apps/notion-as-code`
for `notion.text(...)` or `notion.file(resourceId)`. The latter creates a file
reference, not an upload or file declaration. These helpers are not root exports.
CLI acceptance of
an intent envelope alone does not establish server support for its contents.

## Use a declared data source in a sync

This example can live directly in `src/syncs/issues.ts`. Move the resource
declaration into an imported helper when sharing it with other capabilities.

```ts
import { database, sync } from "@notionhq/apps"
import { Builder } from "@notionhq/apps/builder"

const issues = database({
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

export default sync({
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

Pass a data source handle, not the whole database handle or a UUID. The SDK
derives the sync schema from that handle. `primaryKey` names a title or text
property by its display name, not its resource ID. Omit that property from
upsert values; the SDK fills it from `key`. Use Apps `Builder` for sync values.
Follow the [sync skill](../sync/SKILL.md) for pagination and reconciliation.

Notion as Code properties are an array with resource IDs and names.
Each data source needs exactly one title property
and unique property names and IDs. The current adapter supports title, text,
number, select, multi-select, status, date, checkbox, URL, email, phone, and file
properties. It rejects other kinds, including relation, formula, rollup, and
person, even though some appear in the declaration type. Status options use
`todo`, `inProgress`, and `complete` arrays. Read the installed adapter before
extending a schema.

## Build and deployment

Run the app's check and build commands, then inspect `dist/provisioning.json`
alongside the manifest. The provisioning artifact contains recorded resource
declarations. Building it does not create live resources. Do not hand-edit
generated artifacts or deploy output from a failed build.

Deployment applies provisioning and connects resources to the app. Cloud
deployment stores resource mappings on the server; local-build deployment
uses local state. Switching modes can recreate resources because their state
is independent. A failed deployment can leave partial changes; there is no
automatic rollback. Report the result before attempting recovery.

Use `ntn apps deploy` for the App workflow. The default path uploads source
for a cloud build and server-side provisioning. With `--local-build`, the
CLI builds the App, reads `dist/provisioning.json` and `dist/manifest.json`,
deploys code, applies Notion as Code intents, and reconciles sync attachments. It matches
each sync's manifest `databaseKey` to a declared data source's `resourceId`,
then resolves the resulting live data source from provisioning state.
`sync` supplies this matching key from the handle. An existing
binding to a different database causes an error instead of silent rebinding.

The standalone command `ntn notion-as-code apply <dir>` is a different
project flow: it builds that directory and reads `dist/intents.json`.
Do not use it as a substitute for Apps deployment or rename the Apps artifact
to fit it. It does not perform the App's sync attachment reconciliation.

Local deployment defaults to state named `apps-<worker-id>` in the CLI's
environment/workspace-scoped config store. The
`--notion-as-code-state-name` option requires `--local-build`. Preserve that
state when updating; local and cloud mappings are not interchangeable.

Removing all declarations removes the build artifact, but does not delete
previously provisioned resources. Keep local deployment state out of Git.
Validate declarations and sync transforms offline; perform deployment only
as part of a requested live task.
