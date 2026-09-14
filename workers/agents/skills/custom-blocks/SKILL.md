---
name: custom-blocks
description: Create, modify, and troubleshoot custom blocks in Notion Workers. Use when the user wants to build interactive UI inside Notion connected to Notion data. Covers the author workflow from project setup to local preview and deployment.
user-invocable: false
---

# Custom blocks

Custom blocks are user-authored interfaces inside Notion that can connect to
Notion workspace data.

Custom blocks are in private alpha. The user's workspace might not have custom
blocks enabled. If Notion reports that the feature is disabled, the workspace
needs access before the user can use the block.

A custom block has two parts:

- A Worker declaration uses `@notionhq/workers` to define the build and required data.
- A frontend uses `@notionhq/custom-blocks` to communicate with Notion from a sandboxed iframe.

Read the relevant package documentation before changing either part.

## Current limitations

Take into account these limits when building a custom block:

- **Network access:** The custom block frontend cannot call external APIs or load dependencies from CDNs.
  Bundle scripts, styles, fonts, and other required assets with the deployed artifact.
  Use the custom blocks SDK to access Notion data.
  Images can also use `data:` URLs and permitted Notion-hosted sources.
- **Query size:** `useDataSource` returns at most 999 rows per query. The default limit is 20.
  The hook does not provide cursor pagination.
  If `hasMore` is true, show that the results are incomplete.
  Do not present calculations over incomplete results as totals for the entire data source.
- **Property support:** Custom blocks do not support every Notion property type or operation.
  Support varies between reading, writing, filtering, and sorting.
  Check the installed SDK documentation and types for each required operation.
- **Query filters:** Filters do not support `or` groups or nested groups.
  Use one property condition or one `and` group.
- **Links and navigation:** Custom blocks cannot open external links.
  They also provide no supported way to open internal Notion links.
  Do not implement link navigation or authentication redirects with `window.open` or `window.location`.
- **Page creation:** `pages.create` cannot set an icon or cover.
  Create the page first. Then use `pages.update` to set its icon or cover.
- **Availability:** Custom blocks require private-alpha access.
  Page guests cannot view custom blocks. Notion Sites does not render them.

## Build the block

React with Vite is recommended. The examples use TypeScript.
You can use any framework that builds an `index.html` file and its browser assets.
The frontend must use the custom blocks SDK to connect to Notion and follow the sandbox constraints.

### 1. Prepare the project

For a new project, create a Worker from a custom block template:

```shell
ntn workers new my-worker-name --template <template>
```

Choose `custom` (minimal), `whiteboard`, `habit-tracker`, or `org-chart`.

Keep the declaration in `src/index.ts` and frontend files in `blocks/<key>/`:

```text
src/index.ts
blocks/<key>/
├── index.html
├── tsconfig.json
├── vite.config.ts
└── src/
    └── index.tsx
```

In `index.html`, include `<div id="root"></div>` and a module script for the frontend entrypoint.

Keep all dependencies in the Worker's root `package.json`.
Do not create a `package.json` inside the block directory.
For React with Vite, run these commands from the Worker root:

```shell
npm install @notionhq/custom-blocks react react-dom
npm install --save-dev @notionhq/custom-blocks-dev-shell @types/react @types/react-dom @vitejs/plugin-react vite
```

### 2. Declare the block

Declare the block in `src/index.ts`:

<!-- prettier-ignore -->
```ts
worker.customBlock(
  "issueBoard", // Declaration key: identifies this block within the Worker.
  {
    name: "Issue board",
    description: "View and update issues",
    icon: { type: "emoji", emoji: "📋" },
    path: "./blocks/issue-board",
    command: "npx vite build",
    output: "dist",
    slashCommand: "issues",
    version: 1,
    dataSources: {
      issues: { // Data source key: use in useDataSource("issues").
        name: "Issues",
        description: "Rows shown by the issue board",
        properties: {
          title: { name: "Title", type: "title" },
          status: { // Property key: read with item.propertiesByKey.status.
            name: "Status",
            type: "status",
          },
        },
      },
    },
  }
)
```

The `dataSources` field defines the required schema. Users bind its keys to actual data sources and properties for each block instance.
Choose descriptive keys. They do not need to match property types.
The `type` field uses Notion Public API type names.

| Field          | Meaning                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------ |
| `name`         | Display name. Defaults to the declaration key.                                             |
| `description`  | Description shown when the user selects a block.                                           |
| `icon`         | One emoji.                                                                                 |
| `slashCommand` | Optional slash command. Use a stable name unique within the Worker, without a leading `/`. |
| `path`         | Block directory relative to the Worker root.                                               |
| `command`      | Build command, run inside `path`.                                                          |
| `output`       | Directory containing the built browser assets.                                             |

Set `command` explicitly. Its default, `npm run build`, can build the Worker instead of the frontend.

Use `type: "static"` when `path` already contains built browser assets:

```ts
worker.customBlock("issueBoard", {
  type: "static",
  path: "./blocks/issue-board/dist",
})
```

### 3. Connect the frontend to Notion

In `blocks/<key>/src/index.tsx`, wrap the React app in `NotionCustomBlock`.
Use `errorFallback` to display initialization errors before the app renders.
Include `NotionTokenScope` and the NDS stylesheet when the UI uses Notion design tokens:

```tsx
import "@notionhq/custom-blocks/nds.css"
import {
  NotionCustomBlock,
  NotionTokenScope,
} from "@notionhq/custom-blocks/react"
import ReactDOM from "react-dom/client"
import "./index.css"
import { App } from "./App"

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root element")

ReactDOM.createRoot(root).render(
  <NotionCustomBlock
    errorFallback={(error) => <div role="alert">{error.message}</div>}
  >
    <NotionTokenScope>
      <App />
    </NotionTokenScope>
  </NotionCustomBlock>
)
```

`NotionCustomBlock` renders its children after initialization succeeds. Every declared data source requires a binding before initialization can complete.
Call React SDK hooks inside this wrapper.
For other frameworks, initialize with `initCustomBlock`.
Do not call `window.parent.postMessage` directly.

### 4. Configure the build and type checks

The Worker's root TypeScript configuration does not cover browser files.
Add `blocks/<key>/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "types": ["vite/client"],
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "jsx": "react-jsx"
  },
  "include": ["src", "vite.config.ts"]
}
```

For React, use this `blocks/<key>/vite.config.ts`:

```ts
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
  },
})
```

In the Worker's root `package.json`, extend `check` to type-check each frontend:

```json
{
  "scripts": {
    "check": "tsc --noEmit && tsc -p blocks/issue-board/tsconfig.json --noEmit"
  }
}
```

Add one `tsc -p blocks/<key>/tsconfig.json --noEmit` command for each block.

## SDK APIs

The custom blocks SDK provides APIs to:

- Read context about the custom block, including its containing page, parent, and current user.
- Create, read, update, and delete pages.
- Query data sources.
- Query users.

### Query data sources

Call `useDataSource("<data-source-key>")` for a declared data source. Read
`items`, `isLoading`, `hasMore`, and `error` from the result. The default limit
is 20 rows. The maximum limit is 999. Set `limit` to control the number of returned rows.
If `hasMore` is true, more rows match the query than the result includes.
The hook does not provide cursor pagination. Read property values from each
item's `propertiesByKey` object.

Check the installed SDK types before using `filter` or `sorts`. Older versions accept only `limit`.
Upgrade the SDK if the installed version does not support the required options.

Use `filter` to select matching rows. Use `sorts` to order the rows.
The `key` fields below refer to property keys in the declaration above:

```tsx
import { useDataSource } from "@notionhq/custom-blocks/react"

function IssueBoard() {
  const { items, isLoading, hasMore, error } = useDataSource("issues", {
    limit: 50,
    filter: { key: "status", status: { does_not_equal: "Done" } },
    sorts: [{ key: "title", direction: "ascending" }],
  })

  if (error) return <div role="alert">{error.message}</div>
  if (isLoading) return <div role="status">Loading issues…</div>
  if (items.length === 0) return <div>No matching issues.</div>

  return (
    <div>
      {hasMore
        ? `Showing the first ${items.length} matching issues.`
        : `${items.length} matching issues.`}
    </div>
  )
}
```

Use `useManifest()` when the frontend needs the declared data-source keys or
schema metadata. It does not return resolved bindings or rows.

Validate property values before using them. Handle loading, empty, and query
error states in the UI. Use `errorFallback` for initialization errors, as described above.
Read the installed SDK documentation
for the current result and value shapes.

### Update pages

Use an item's `update` method to update a row from a bound data source:

```tsx
const updateResult = await item.update({
  properties: {
    status: { type: "status", status: { name: "Done" } },
  },
})

if (updateResult.status === "error") {
  // Handle updateResult.error.
}
```

Use `pages.create` with a `data_source_key` parent to add a row to a bound
source. Use `pages.delete` to archive a page. Use raw property IDs with
`pages.update`. Data and page operations return result objects instead of
throwing:

```ts
const result = await pages.update({
  pageId,
  properties: {
    "status-property-id": {
      id: "status-property-id",
      type: "status",
      status: { name: "Done" },
    },
  },
})

if (result.status === "error") {
  if (result.error.isRetryable) {
    // Retry only when the SDK marks the error as retryable.
  }
  // Branch on result.error.code. Use message for display only.
}
```

## Security

Use the custom blocks SDK for Notion data access.
Do not call the Notion API or host bridge directly from the iframe.

### Sandbox

Each block runs in a sandboxed iframe. It cannot access Notion's DOM,
cookies, storage, session, or API credentials.

- The sandbox blocks external API requests and CDN dependencies.
  Bundle scripts, styles, fonts, and other runtime dependencies.
  Network requests are restricted to the block's bundle endpoints.
  Navigation can reach only the block's origin.
- Images support bundled files, `data:` URLs, and permitted Notion-hosted images.
- Fonts support bundled files and `data:` URLs.
- Within a workspace, instances of the same Worker capability share an origin and `localStorage`.
  `sessionStorage` is also scoped to the browser tab.
  Different capability keys or Workers have separate origins and storage.
- Forms and `<base>` elements are not allowed.

### Permissions

Reads and writes use the viewer's permissions, including row permissions.
Results can differ between viewers.

Initialization requires viewer read access to every bound data source.
Containing-page access does not grant this access.
Handle write-access errors even after initialization succeeds.

Block instances inherit page permissions. Users with edit access can change bindings.
Page guests cannot view custom blocks. Notion Sites does not render them.

Use trusted authors. Malicious blocks can copy private viewer data
to pages or data sources their authors can read.

### Secrets and dependencies

Viewers can inspect the frontend bundle.
Exclude secrets, tokens, and private URLs from the bundle.
Store secrets in the Worker on the server.

Review third-party dependencies. Pin trusted versions.
Build tools can access the Worker project despite runtime network restrictions.

See [Security](https://developers.notion.com/custom-blocks/guides/security).

## Layout and accessibility

All interactive controls must be keyboard-reachable. Expose loading and failure
states to assistive technology.

### Sizing

`NotionCustomBlock` automatically resizes React blocks to fit their content.
For a frontend without React, wait for `initCustomBlock()` to resolve.
Then call `customBlock.autoResize({ target })` with the element that determines the iframe height.

Notion limits automatic heights to between 100 and 10,000 pixels.
To restrict content height further, configure `#root` as follows:

```css
#root {
  max-height: 600px;
  overflow-y: auto;
}
```

When a viewer drags the resize handle, the selected height overrides automatic sizing.
Automatic sizing resumes when the viewer selects **Fit content**.

See [Sizing](https://developers.notion.com/custom-blocks/sdk/appearance#sizing).

## Verify with the dev shell

### Check the code and bundle

Run the available check, test, and build scripts from the Worker root:

```shell
npm run check
npm test
npm run build
```

Build each frontend separately. The Worker build does not check the frontend bundle.
Run this command from the Worker root. The subshell preserves the current directory:

```shell
(cd blocks/<key> && npx vite build)
```

### Start the local preview

The [dev shell](https://developers.notion.com/custom-blocks/guides/preview) (`@notionhq/custom-blocks-dev-shell`) tests the declaration and frontend together.
It supports sample data, including data sampled from production.

```shell
ntn workers customblocks dev
```

See the dev shell package documentation for details.
Test through the dev shell instead of opening the block's URL directly.

### Add sample data and check behavior

For Worker data, the dev shell automatically creates and binds a database. The database starts without rows.

1. Add sample rows manually or sample a production database with `ntn workers customblocks sample`.
2. Check that the block renders the expected data.
3. Check that the main interaction works.

In React blocks, press `\` to show the SDK debug console.
Press `\` again to return to the block.

Report which checks you completed. Identify any checks you could not complete.
State whether you tested in the dev shell or Notion.
Local checks do not establish that production permissions and sandbox behavior work.

## Deploy and share

Deploy the block with its Worker only when the user asks for a live deployment:

```shell
ntn workers deploy
```

Do not use `ntn workers exec` for a custom block. It has no `execute` handler.

After deployment, insert a block instance from Notion's slash menu or use the CLI
from the Worker root:

```shell
ntn workers customblocks make --key issueBoard --target <page-id-or-url>
```

`--key` identifies the deployed block. `--target` identifies the page or block
that receives the instance.

In Notion, connect each declared data source and map its properties. Check that
the configured block renders and its main interaction works.

[Share the Worker](https://developers.notion.com/workers/guides/sharing-workers) with **Can connect** access when another workspace member must
insert the block. **Full access** also permits Worker management and deployment.

## References

Use these links for Workers and custom block guidance:

- [Workers quickstart](https://developers.notion.com/workers/get-started/quickstart)
- [Workers SDK reference](https://developers.notion.com/workers/reference/sdk)
- [Sharing Workers](https://developers.notion.com/workers/guides/sharing-workers)
- [Custom block data sources](https://developers.notion.com/custom-blocks/guides/data-sources)
- [How a block initializes](https://developers.notion.com/custom-blocks/guides/lifecycle)
- [Security](https://developers.notion.com/custom-blocks/guides/security)
- [Custom blocks SDK](https://www.npmjs.com/package/@notionhq/custom-blocks)
- [Preview custom blocks](https://developers.notion.com/custom-blocks/guides/preview)
