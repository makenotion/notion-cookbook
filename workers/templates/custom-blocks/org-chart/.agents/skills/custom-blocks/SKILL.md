---
name: custom-blocks
description: Build or modify a custom block frontend in a Notion Worker. Use when the user asks for code inside a Notion custom block.
user-invocable: false
---

# Custom blocks

## Access and source of truth

Read the project's root `AGENTS.md` before you change code. Continue only when
the instructions allow custom blocks and the target workspace has custom-block
alpha access. Ask the user to confirm access when it is unknown. The `ntn
workers new <directory> --template custom` command, the installed SDK, and this
skill do not grant access.

Read the installed package documentation before you write block code:

- `node_modules/@notionhq/custom-blocks/README.md`
- `node_modules/@notionhq/custom-blocks-dev-shell/README.md`

Read the task-relevant documentation and TypeScript declarations in those
packages. The installed documentation and declarations are authoritative when
they differ from this skill or from older examples.

The current cookbook flow uses `blocks/<key>/` for frontend source. Do not copy
the older `views/<key>/`, `custom_blocks.json`, or `ncblock` workflow from old
worker-template guidance unless the installed package documentation requires it.

## Architecture and package layout

A custom block has two code halves:

- `src/index.ts` uses `@notionhq/workers` to declare the block's source, build
  command, and data-source schemas.
- The block directory uses `@notionhq/custom-blocks` to communicate with the
  Notion host from its sandboxed iframe.

Keep one package at the worker root. Add frontend dependencies to that package.
Do not create a second `package.json` inside the block directory.

Use this layout for a new cookbook block:

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

## TypeScript and Vite setup

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

The IPv4 host setting keeps local development reachable when localhost resolves
to IPv6.

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

Set `path` relative to the worker root. The build command runs inside that
directory. Set the command explicitly when the block has no nested
`package.json`:

```ts
worker.customBlock("issueBoard", {
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

The default project build command is `npm run build`. A block without its own
package can therefore invoke the worker's root build instead of producing a
browser bundle. Set `command: "npx vite build"` and `output: "dist"` for a
Vite block.

Keep `version: 1`. The current custom block manifest requires version 1.

The `dataSources` value declares a schema. It does not bind the block to a
specific database. Data-source keys and property keys are author-defined. The
block instance receives concrete bindings when a user configures it.

Property types use Public API names. Common types include `title`, `rich_text`,
`number`, `select`, `multi_select`, `status`, `date`, `people`, `files`,
`checkbox`, `url`, `email`, `phone_number`, `formula`, `relation`, and `rollup`.

Use a static source only when `path` already contains built browser assets:

```ts
worker.customBlock("issueBoard", {
  type: "static",
  path: "./blocks/issue-board/dist",
})
```

`slashCommand` is optional. It adds a dedicated command to Notion's slash menu.
Do not include the leading `/`. Use a stable command that is unique within the
worker. Omit the field when the block does not need a dedicated command.

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
  <NotionCustomBlock autoResize>
    <NotionTokenScope>
      <App />
    </NotionTokenScope>
  </NotionCustomBlock>
)
```

`NotionCustomBlock` performs the host handshake. It also resizes the iframe when
`autoResize` is enabled. Use `initCustomBlock` for a framework-neutral frontend.

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

## Read and write Notion data

Call `useDataSource("<data-source-key>")` for a declared data source. Read
`items`, `isLoading`, `hasMore`, and `error` from the result. The default limit
is 20 rows. The maximum limit is 999. Set `limit` explicitly when the block
needs more rows, and handle `hasMore` instead of assuming that the result is
complete. Read property values from each item's `propertiesByKey` object.

Validate property values before using them. Handle loading, empty, and query
error states in the UI. Binding errors occur during initialization and require
the `errorFallback` path above. Read the installed SDK documentation for the
current result and value shapes.

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

Use the SDK's documented `pages` helpers to create or archive pages. Use raw
property IDs with `pages.update`. Data and page operations return result objects
instead of throwing:

```ts
const result = await pages.update({ pageId, properties })

if (result.status === "error") {
  if (result.error.isRetryable) {
    // Retry only when the SDK marks the error as retryable.
  }
  // Branch on result.error.code. Use message for display only.
}
```

Do not call the Notion API or the host bridge directly from the iframe.

## Sandbox and layout constraints

Treat bundled block code as public. Do not put secrets, tokens, or private URLs
in the frontend bundle.

The block reads and writes with the viewer's permissions. A malicious block can
copy private data that the viewer can read to a page or data source that the
block author can read. Use custom blocks only from trusted authors, and treat
sensitive data-source bindings with care.

Do not make external network requests from block code. Do not use top-level
navigation, `window.open`, or authentication redirects. Bundle all runtime
dependencies.

The host owns the iframe width. Avoid fixed widths and `100vh` unless the
layout intentionally fills the viewport. Prefer intrinsic height and container
queries.

All interactive controls must be keyboard-reachable. Expose loading and failure
states to assistive technology.

## Develop, verify, and deploy

Run the worker checks from the worker root:

```shell
npm run check
npm test
npm run build
```

Build the frontend separately when you need to verify its bundle:

```shell
cd blocks/<key> && npx vite build
```

Use the custom blocks dev shell for local integration testing:

```shell
ntn customblocks dev
```

The dev shell builds the worker, serves each block with Vite, and renders the
block in a mock Notion host with sample data.

Deploy the block with its worker only when the user asks for a live deployment:

```shell
ntn workers deploy
```

Do not use `ntn workers exec` for a custom block. It has no `execute` handler.
Do not use a separate custom block deploy command.

After deployment, insert the block from the slash menu. Bind every declared
data source to a real data source. A deployed definition without a configured
block instance is not a complete verification.

Share the worker with **Can connect** access when another workspace member must
insert the block. **Full access** also permits worker management and deployment.
