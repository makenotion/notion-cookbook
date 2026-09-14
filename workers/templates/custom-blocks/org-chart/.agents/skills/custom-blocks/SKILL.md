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

A custom block is a frontend web app that Notion serves in an iframe. The
`worker.customBlock()` declaration defines the block's build and data source
schema. The block has no `execute` handler, so `ntn workers exec` cannot run it.

The block uses two packages:

- `@notionhq/workers` declares the block's build and data source schemas.
- `@notionhq/custom-blocks` lets the iframe frontend communicate with Notion.

The `@notionhq/custom-blocks` and `@notionhq/custom-blocks-dev-shell` packages
include documentation. Read the relevant documentation and TypeScript declarations
before writing block code. Use these references for the installed package version.

## Create or modify the block

Available templates: `custom` (minimal), `whiteboard`, `habit-tracker`, and `org-chart`.

Create the worker with the selected template:

```shell
ntn workers new my-worker-name --template <template>
```

A custom block has two parts:

- `src/index.ts` uses `@notionhq/workers` to declare the block's source, build
  command, and data source schemas.
- The block directory uses `@notionhq/custom-blocks` to communicate with the
  Notion host from its sandboxed iframe.

Use the worker's root `package.json` for all dependencies, including frontend dependencies.
Do not add a `package.json` inside the block directory.

A minimal layout for a block's code looks like:

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

Install dependencies from the worker root. Use the React commands only when
the block uses React:

```shell
npm install @notionhq/custom-blocks react react-dom
npm install --save-dev @notionhq/custom-blocks-dev-shell @types/react @types/react-dom @vitejs/plugin-react vite
```

### Recommended setup: React and Vite

You can use any web framework that builds an `index.html` file and the browser
assets it needs. The app must use the custom blocks SDK to connect to Notion
and follow the sandbox constraints below. React with Vite is the recommended
setup. The examples below use TypeScript.

The worker's root TypeScript configuration does not cover browser files. Add a
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

Extend the worker root `check` script to type-check every block frontend:

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

```ts
worker.customBlock("issueBoard", {
  name: "Issue board",
  description: "View and update issues",
  icon: { type: "emoji", emoji: "📋" },
  path: "./blocks/issue-board",
  command: "npx vite build",
  output: "dist",
  slashCommand: "issues",
  version: 1,
  dataSources: {
    issues: {
      name: "Issues",
      description: "Rows shown by the issue board",
      properties: {
        title: { name: "Title", type: "title" },
        status: { name: "Status", type: "status" },
      },
    },
  },
})
```

### Display & appearance

`name` sets the block's display name. If omitted, Notion uses the declaration key.
`description` appears when the user selects a block. `icon` currently supports
only a single emoji.

### Data sources

The `dataSources` field declares the required schema. You define the data source
keys and property keys. A binding connects a declared key to an actual data source
or property. The user configures these bindings for each block instance.

Property types use Notion Public API names. Property support varies by API and
is currently limited, especially for formulas, rollups, and relations.

### Slash command

`slashCommand` adds an optional command to Notion's slash menu. Use a stable name
that is unique within the worker. Write the name without the leading `/`.

### Build and static files

`path` points to the block directory, relative to the worker root. `command`
runs in that directory. `output` names the directory with the built browser assets.
For Vite, use `command: "npx vite build"` and `output: "dist"`.

Set `command` explicitly. The default is `npm run build`, which can run the
worker's build instead of building the frontend.

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

`NotionCustomBlock` connects the frontend to Notion and resizes the iframe automatically.
`NotionCustomBlock` renders its children after initialization succeeds. Every declared
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
is 20 rows. The maximum limit is 999. Use `limit` to control how many rows the query returns.
If `hasMore` is true, more rows match the query than the result includes.
The hook does not provide cursor pagination. Read property values from each
item's `propertiesByKey` object.

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
error states in the UI. Binding errors occur during initialization. Show them
through the `errorFallback` path above. Read the installed SDK documentation
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

Do not call the Notion API or the host bridge directly from the iframe.

## Security

### Sandbox

Each block runs in a separate iframe on its own origin. It cannot access
Notion's DOM, cookies, storage, session, or API credentials. Use the custom blocks
SDK to read or change Notion data.

- Bundle scripts, styles, fonts, and other runtime dependencies. Do not load dependencies from a CDN.
- Network requests and navigation can reach only the block's own origin.
- Images can use bundled files, `data:` URLs, or Notion-hosted images.
- Fonts can use bundled files or `data:` URLs.
- `localStorage` and `sessionStorage` belong to the block's origin. Separate blocks do not share them, even within one worker.
- Forms and `<base>` elements are not allowed.

### Permissions

The block reads and writes with the viewer's permissions. Row permissions still
apply, so viewers can see different results from the same block.

The viewer must have read access to every bound data source before the block
can initialize. Access to the containing page does not grant access to those
data sources. Writes can still fail after the block loads. Handle access errors
in the UI.

A block instance inherits its page's permissions. Users with edit access can
change its bindings. Page guests cannot view custom blocks. Custom blocks do not
render on pages published with Notion Sites.

Use blocks only from trusted authors. A malicious block can copy a viewer's
private data to a page or data source that its author can read.

### Secrets and dependencies

Viewers can inspect the frontend bundle. Keep secrets, tokens, and private URLs
out of it. Store secrets in the worker, where they remain on the server.

Review third-party dependencies and pin trusted versions. Build tools can access
the worker project, so blocked network access at runtime does not remove build risks.

See [Security](https://developers.notion.com/custom-blocks/guides/security).

## Layout and accessibility

All interactive controls must be keyboard-reachable. Expose loading and failure
states to assistive technology.

### Sizing

`NotionCustomBlock` automatically resizes React blocks to fit their content.
For a frontend without React, wait for `initCustomBlock()` to resolve.
Then call `customBlock.autoResize({ target })` with the element that determines the iframe height.

Notion limits automatic heights to between 100 and 10,000 pixels.
To limit the content height further, set `max-height` and `overflow-y` on `#root`:

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

Run the available check, test, and build scripts from the worker root:

```shell
npm run check
npm test
npm run build
```

Build the frontend separately when you need to verify its bundle:

```shell
cd blocks/<key> && npx vite build
```

Use the [dev shell](https://developers.notion.com/custom-blocks/guides/preview) to test the block locally:

```shell
ntn workers customblocks dev
```

The dev shell builds the worker. It serves each block with Vite. It renders the
block in a mock Notion host with sample data.

The dev shell reads `data/*.json` from the worker root at startup.
Restart the dev shell after you change those files. Blocks start without bindings.

1. Connect each declared data source to sample data.
2. Map every declared property.
3. Check that the block renders.
4. Check that the block's main interaction works.

Test through the dev shell instead of opening the block's URL directly.
In React blocks, press `\` to show the SDK debug console.
Press `\` again to return to the block.

Report which checks you completed. State whether you tested the block in the dev shell
or in Notion.

## Deploy and share

Deploy the block with its worker only when the user asks for a live deployment:

```shell
ntn workers deploy
```

Do not use `ntn workers exec` for a custom block. It has no `execute` handler.

After deployment, insert a block instance from Notion's slash menu or use the CLI
from the worker root:

```shell
ntn workers customblocks make --key issueBoard --target <page-id-or-url>
```

`--key` identifies the deployed block. `--target` identifies the page or block
that receives the instance.

In Notion, connect each declared data source and map its properties. Check that
the configured block renders and its main interaction works.

[Share the worker](https://developers.notion.com/workers/guides/sharing-workers) with **Can connect** access when another workspace member must
insert the block. **Full access** also permits worker management and deployment.

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
