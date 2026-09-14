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
  Use filters to select relevant rows and sorts to order them.
  Load rows progressively by increasing `limit` as needed, up to 999.
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

The frontend must use the custom blocks SDK to connect to Notion and follow the sandbox constraints.
You can use any framework that builds an `index.html` file and its browser assets.
We recommend React with Vite. The examples below use React, Vite, and TypeScript.

### 1. Prepare the project

For a new project, create a Worker from a custom block template:

```shell
ntn workers new my-worker-name --template <template>
```

There are 4 templates to choose from: `custom` (minimal), `whiteboard`, `habit-tracker`, and `org-chart`.

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

| Field          | Meaning                                                                                                                            | Default                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `name`         | Display name shown for the block.                                                                                                  | Falls back to declaration key |
| `description`  | Description shown when the user selects a block.                                                                                   | —                             |
| `icon`         | Icon shown for the block in Notion. Only `type: "emoji"` is currently supported.                                                   | —                             |
| `slashCommand` | Adds a command that inserts the block from Notion's slash menu. Use a stable name unique within the Worker, without a leading `/`. | —                             |
| `path`         | Path to the block directory, relative to the Worker root. Required.                                                                | —                             |
| `command`      | Command that builds the frontend. Runs inside `path`.                                                                              | `npm run build`               |
| `output`       | Directory containing the built browser assets, relative to `path`.                                                                 | `dist`                        |

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

Include `NotionTokenScope` and the NDS stylesheet when the UI uses Notion design tokens.

`NotionCustomBlock` renders its children after initialization succeeds. Every declared data source requires a binding before initialization can complete.
Call React SDK hooks inside this wrapper.

For other frameworks, initialize with `initCustomBlock`.

Do not call `window.parent.postMessage` directly.

`NotionCustomBlock` automatically resizes to fit content. Other frameworks can call `customBlock.autoResize({ target })` after initialization.
See [Sizing](https://developers.notion.com/custom-blocks/sdk/appearance#sizing) for height limits and manual resizing.

Make interactive controls keyboard-accessible. Expose loading and error states to assistive technology.

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

Run the available check, test, and build scripts from the Worker root:

```shell
npm run check
npm test
npm run build
```

## SDK APIs

The custom blocks SDK provides APIs to:

- Read block context, including the containing page, parent, and current user.
- Read app context, including theme and contrast settings.
- Read declared data sources and schema metadata.
- Query, filter, and sort data source rows.
- Create, read, update, and archive pages.
- Read and list users.

Read the installed `@notionhq/custom-blocks` documentation and exported types for current methods, API signatures, and error handling.

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

Only trust custom blocks from trusted authors. Malicious blocks can copy private viewer data
to pages or data sources their authors can read.

### Secrets and dependencies

Viewers can inspect the frontend bundle.
Exclude secrets, tokens, and private URLs from the bundle.
Store secrets in the Worker on the server.

Review third-party dependencies. Pin trusted versions.
Build tools can access the Worker project despite runtime network restrictions.

See [Security](https://developers.notion.com/custom-blocks/guides/security).

## Verify with the dev shell

The [dev shell](https://developers.notion.com/custom-blocks/guides/preview) provides a local preview of your custom block with sample Notion data.
Use `@notionhq/custom-blocks-dev-shell` to test the declaration and frontend together before deployment.
Run it from the Worker root:

```shell
ntn workers customblocks dev
```

Test through the dev shell instead of opening the block's URL directly.
For Worker data, the dev shell creates and binds an empty database.
Add rows manually or sample a production database with `ntn workers customblocks sample`.
Check that the block renders the expected data and its main interaction works.

In React blocks, press `\` to toggle the SDK debug console.
See the dev shell package documentation for details.

Report what you tested and any checks you could not complete.
Dev shell tests do not verify production permissions or sandbox behavior.

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
