---
name: custom-blocks
description: Build interactive UI inside Notion connected to workspace data. Covers creating, modifying, and troubleshooting custom blocks from project setup through deployment.
user-invocable: false
---

# Custom blocks

Custom blocks are user-authored interfaces inside Notion. They can connect to
workspace data, read the current user's identity, and interact with native Notion UI.

Custom blocks are in private alpha and may be disabled for the user's workspace.

A **definition** is a reusable description of a custom block. An **instance**
places that definition inside Notion. Instances can take different forms,
including blocks, views, and pages.

A definition requires two pieces of code:

- A declaration in the Worker file uses `@notionhq/workers` to specify the block's configuration and data requirements.
- A frontend web app uses `@notionhq/custom-blocks` to implement the UI and interact with Notion.

Read the relevant package documentation before changing either part.

## Current limitations

Take into account these limits when building a custom block:

- **External resources:** External requests and resources require workspace approval.
  Notion-hosted media and Google Fonts work without approval. Bundle JavaScript dependencies directly.
- **Browser capabilities:** The sandbox and content security policy restrict browser capabilities,
  including browser workers, form submissions, popups, and top-level navigation.
  See [Security](#security) for details.
- **Query results:** Query results are limited to 1,000 rows. There is no offset pagination.
- **Page property support:** Property support varies across
  [page reads and writes](https://developers.notion.com/custom-blocks/sdk/pages) and
  [data source queries, filters, and sorts](https://developers.notion.com/custom-blocks/sdk/data-sources).
- **Notion Sites:** Custom blocks do not render on published Notion Sites.
  This applies to all viewers, including workspace members.

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

After deployment, use `ntn workers customblocks make --help` to check the installed
CLI's inputs. Run `make` from the deployed Worker root. `--key` selects the
capability. With no target, it creates a private custom page. An ordinary page or
block target receives a new inline instance; an existing custom page or custom
block target is configured in place. Custom database views are not supported by
this CLI/Public API flow.

### Connect an instance to data

Use instance bindings when connecting one placement to the user's existing data.
Definition defaults are shared by instances that inherit them; changing a default
is not the normal way to configure one placement.

Resolve each database to its data-source ID with
`ntn datasources resolve <database-id>`. Read its schema with
`ntn api v1/data_sources/<data-source-id>`.
Match the declared data-source keys and map declared property keys to actual
property IDs. Do not use property names as IDs or invent a mapping.

Use property IDs exactly as returned by the schema in `property_ids_by_key`.
The API resolves encoded IDs and rejects unknown IDs or mappings incompatible
with the definition's declared property types.

If `make --help` lists `--bindings`, write `bindings.json` as an array:

```json
[
  {
    "key": "issues",
    "data_source_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "property_ids_by_key": { "title": "title" }
  }
]
```

Replace the example ID and mappings with the resolved values. Create an inline
instance under the selected page:

```shell
ntn workers customblocks make --key issueBoard --target <page-id-or-url> --bindings @bindings.json --json
```

Omit `--target` to create a private custom page. Preserve the returned `block_id`
and `block_url` when present. A supplied binding array replaces the instance's
overrides. Omit `--bindings` to preserve them; `--bindings '[]'` clears overrides
so definition defaults apply. Existing targets accept the same definition; a
different definition is rejected before changing bindings.

If the installed CLI does not list `--bindings`, create or select the instance
without that flag, then configure its bindings through `ntn api` as below.
Do not report manual UI connection as required when the API can complete it.

For later binding edits, prepare `update.json` containing
`{"custom_block":{"data_sources":[...]}}` for an inline block, or
`{"custom_page":{"data_sources":[...]}}` for a custom page. Use the same binding
array shape as above and supply the full desired override list. These are file
shapes, not literal payloads containing `...`.

```shell
ntn api v1/blocks/<instance-id> -X PATCH -d @update.json
```

For a custom page, use `v1/pages/<instance-id>` instead. Omit `definition_id` for a
bindings-only edit. The API also accepts it when it matches the stored definition;
it rejects a different definition.

After saving, fetch the instance with `ntn api v1/blocks/<instance-id>` or
`ntn api v1/pages/<instance-id>`. Check the saved definition, data source IDs, and
property mappings.

Legacy saved mappings may contain percent-encoded property IDs. The host resolves
these IDs without rewriting stored bindings. Do not decode an ID just because it
contains `%`.

Verify that the instance renders with the expected data and its main interaction
works. Report any permission, feature-gate, or verification failure instead of
claiming setup is complete.

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
