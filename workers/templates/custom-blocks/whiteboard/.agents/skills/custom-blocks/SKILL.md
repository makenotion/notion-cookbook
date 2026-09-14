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

## How custom blocks work

Custom blocks have two parts: a Worker declaration and a frontend.

- `@notionhq/workers` provides `worker.customBlock()` to define how the block builds and what data it needs.
- `@notionhq/custom-blocks` lets the frontend communicate with Notion from a sandboxed iframe.

Test the Worker declaration and frontend together in the custom block dev shell (`@notionhq/custom-blocks-dev-shell`).

Each package includes documentation. Read the relevant documentation before writing or updating code.

## Create or modify the block

Custom blocks are a Workers capability. To create a custom block, create a Worker from a custom block template:

```shell
ntn workers new my-worker-name --template <template>
```

Available templates: `custom` (minimal), `whiteboard`, `habit-tracker`, and `org-chart`.

Use the Worker's root `package.json` for all dependencies, including frontend dependencies.
Do not add a `package.json` inside the block directory.

A minimal layout for the declaration and frontend:

```text
src/index.ts
blocks/<key>/
├── index.html
├── tsconfig.json
├── vite.config.ts
└── src/
    └── index.tsx
```

The HTML file must contain a `<div id="root"></div>` element. Its module script
must point to the frontend entrypoint.

Install dependencies from the Worker root. Use the React commands only when
the block uses React:

```shell
npm install @notionhq/custom-blocks react react-dom
npm install --save-dev @notionhq/custom-blocks-dev-shell @types/react @types/react-dom @vitejs/plugin-react vite
```

### Recommended setup: React and Vite

React with Vite is the recommended setup. The examples below use TypeScript.
Other frameworks must build an `index.html` file and its browser assets.
The app must use the custom blocks SDK to connect to Notion.
It must follow the sandbox constraints below.

Data source queries currently require React's `useDataSource` hook.
Framework-neutral initialization does not provide an equivalent query API.

The Worker's root TypeScript configuration does not cover browser files. Add a
`tsconfig.json` inside each block:

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

Use a Vite configuration like this for a React block:

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

Extend the Worker root `check` script to type-check every block frontend:

```json
{
  "scripts": {
    "check": "tsc --noEmit && tsc -p blocks/issue-board/tsconfig.json --noEmit"
  }
}
```

Add one `tsc -p blocks/<key>/tsconfig.json --noEmit` command for each block.

## Declare the block

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

Data source and property keys are names you choose. Property keys do not need to match their types.
For example, the first property key could be `name` or `Title`.
The `type` field defines the property's data type with Notion Public API names.

### Display & appearance

`name` sets the block's display name. If omitted, Notion uses the declaration key.
`description` appears when the user selects a block. `icon` currently supports
only a single emoji.

### Data sources

The `dataSources` field declares the required schema.
A binding connects a declared key to an actual data source or property. The user configures these bindings for each block instance.

Property support varies by API. Support is currently limited, especially for formulas, rollups, and relations.

### Slash command

`slashCommand` adds an optional command to Notion's slash menu. Use a stable name
that is unique within the Worker. Write the name without the leading `/`.

### Build and static files

`path` points to the block directory, relative to the Worker root. `command`
runs in that directory. `output` names the directory with the built browser assets.
For Vite, use `command: "npx vite build"` and `output: "dist"`.

Set `command` explicitly. The default is `npm run build`, which can run the
Worker's build instead of building the frontend.

Use `type: "static"` when `path` already contains built browser assets:

```ts
worker.customBlock("issueBoard", {
  type: "static",
  path: "./blocks/issue-board/dist",
})
```

## Initialize the frontend

Wrap a React block in `NotionCustomBlock`. Add `NotionTokenScope` and the NDS
stylesheet when the UI uses Notion design tokens:

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
  <NotionCustomBlock>
    <NotionTokenScope>
      <App />
    </NotionTokenScope>
  </NotionCustomBlock>
)
```

`NotionCustomBlock` connects the frontend to Notion. It renders its children after initialization succeeds. Every declared
data source must have a binding before initialization can complete.
Use `initCustomBlock` to initialize a frontend without React.

Initialization failures happen before the block's children render. Pass
`errorFallback` to show a useful message for missing bindings, protocol errors,
and other handshake failures:

```tsx
<NotionCustomBlock errorFallback={(error) => <BlockError error={error} />}>
  <App />
</NotionCustomBlock>
```

Use hooks from `@notionhq/custom-blocks/react` inside the wrapper. Do not call
`window.parent.postMessage` directly.

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

The [dev shell](https://developers.notion.com/custom-blocks/guides/preview) lets you test blocks locally with sample data, including data sampled from production.

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
