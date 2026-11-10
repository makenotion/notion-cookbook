---
name: custom-blocks
description: Build interactive UI inside Notion connected to workspace data. Covers creating, modifying, and troubleshooting custom blocks from project setup through deployment.
user-invocable: false
---

# Custom blocks

> **Warning:** Custom blocks are in private alpha and may be disabled for the user's workspace.

Custom blocks are user-authored interfaces inside Notion. They can connect to
workspace data, read the current user's identity, and interact with native Notion UI.

A **definition** is a reusable description of a custom block. An **instance**
places that definition inside Notion. Instances can take different forms,
including blocks, views, and pages.

A definition requires two pieces of code:

- A declaration in the Worker file uses `@notionhq/workers` to specify the block's configuration and data requirements.
- A frontend web app uses `@notionhq/custom-blocks` to implement the UI and interact with Notion.

Read the relevant package documentation before changing either part.

## Limitations

Take into account these limits when building a custom block:

- **External resources:** External requests and resources require workspace approval.
  Notion-hosted media and Google Fonts work without approval. Bundle JavaScript dependencies directly.
- **Browser capabilities:** The sandbox and content security policy restrict browser capabilities,
  including browser workers, form submissions, popups, and top-level navigation.
  See [Security](#security) for details.
- **Data source query results:** Individual queries return up to 1,000 rows.
  They do not support pagination. Use filters to narrow results and `hasMore` to detect incomplete results.
- **Page property support:** Property support varies across
  [page reads and writes](https://developers.notion.com/custom-blocks/sdk/pages) and
  [data source queries, filters, and sorts](https://developers.notion.com/custom-blocks/sdk/data-sources).
- **Notion Sites:** Custom blocks do not render on published Notion Sites.
  This applies to all viewers, including workspace members.

## Build and use a custom block

### 1. Start from a template

Create a Worker from a custom block template:

```shell
ntn workers new my-worker-name --template custom
```

Choose `custom` for a minimal app, or start from `whiteboard`, `habit-tracker`, or
`org-chart`. The templates include a Worker declaration, React frontend, Vite
configuration, dependencies, and type checks. Inspect and adapt the generated
files instead of recreating them.

From the generated Worker root, run `npm install` if dependencies are not already
installed.

Keep frontend packages in the Worker's root `devDependencies`. The `dependencies`
are for the Worker runtime. The frontend can use any
framework that produces an `index.html` file and browser assets. The templates
and examples below use React, Vite, and TypeScript.

### 2. Configure the definition

Adapt the `worker.customBlock()` declaration in `src/index.ts`:

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
        icon: { type: "emoji", emoji: "🐛" },
        properties: {
          title: { name: "Title", type: "title" },
          status: { // Property key: read with item.getPropertyByKey("status").
            name: "Status",
            type: "status",
          },
        },
      },
    },
  }
)
```

The declaration key (`issueBoard`) identifies the definition within the Worker.
`path` selects the frontend directory relative to the Worker root. It does not
need to match the key. `command` runs inside that directory, and `output` is
relative to it.

Set `command` explicitly. Its default, `npm run build`, can build the Worker
instead of the frontend. For an already-built frontend, use `type: "static"`
and set `path` to the directory containing its `index.html` and assets.

`dataSources` declares the data sources and properties the frontend uses.
Bindings connect these declarations to workspace data for each instance.
Refer to data sources and properties by their declared keys so the same frontend
can work across the workspace without hard-coded IDs. Property `type` values use
Notion Public API names.

See the [Workers SDK reference](https://developers.notion.com/workers/reference/sdk)
for declaration fields and defaults.

### 3. Implement the frontend

Use `@notionhq/custom-blocks` to access Notion data, read user and app context,
and interact with Notion UI. Read the installed package's API documentation and
exported types for current methods, supported operations, and error handling.

The library communicates with the Notion app over a `postMessage` bridge.
The SDK handles that communication and provides a typed API for interacting with
Notion. Use the SDK rather than the bridge directly.

In the frontend entrypoint, wrap the React app in `NotionCustomBlock`:

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

`NotionCustomBlock` renders its children after initialization succeeds. Call React
SDK hooks inside the wrapper. For other frameworks, initialize with
`initCustomBlock`.

Include `NotionTokenScope` and the NDS stylesheet when the UI uses Notion design
tokens. Make controls keyboard-accessible and expose loading and error states to
assistive technology.

The React wrapper reports content height automatically. Custom pages use the
available page height. Other frameworks can call
`customBlock.autoResize({ target })` after initialization. See
[Sizing](https://developers.notion.com/custom-blocks/sdk/appearance#sizing).

Keep a frontend `tsconfig.json` and include it in the root `check` script. The
Worker's TypeScript configuration does not cover browser files. When adding
another frontend, add its type check alongside the template's existing checks.

### 4. Verify locally

Run the project's type checks and applicable tests from the Worker root:

```shell
npm run check
npm test
```

Use the dev shell for rendering and interactions with local sample data.
Use in-app preview to test local UI changes against workspace data before
deployment. Preview writes still change real data under the viewer's
permissions.

Follow the SDK's local development guide for startup, connection, and browser
verification. Read the installed guide at
`node_modules/@notionhq/custom-blocks/docs/local-development.md`. If it is
absent, read [Verify a custom block locally](https://unpkg.com/@notionhq/custom-blocks@latest/docs/local-development.md)
from the latest published SDK.

If in-app preview is unavailable, use the dev shell and report that the Notion
host remains unverified. Report which host you used and what you observed.

### 5. Deploy the Worker

Deploy only when the user asks for a live deployment:

```shell
ntn workers deploy
```

Normal deployment builds the Worker and frontend remotely using the declared
build command. Do not use `ntn workers exec` for a custom block. It has no
`execute` handler.

### 6. Create and connect an instance

After deploying the Worker, create an instance of its definition inside Notion.
Run `make` from the deployed Worker root:

```shell
ntn workers customblocks make --key issueBoard --target <page-id-or-url> --json
```

`--key` selects the deployed definition. `--target` places a custom block instance
under a page or block, or configures an existing custom instance. Omit `--target`
to create a private custom page instance. Preserve the returned instance ID and URL.

If the definition declares data sources, each needs a binding before the instance
can initialize. Instances can inherit bindings from the definition or provide
their own. When available, `make --bindings` creates the instance and sets its
bindings in one command. Prepare bindings before running `make` to use this option.

Resolve each database with `ntn datasources resolve <database-id>` and read its
schema with `ntn api v1/data_sources/<data-source-id>`. Map declared keys to actual
data source and property IDs. Pass property IDs exactly as returned by the schema.

Write `bindings.json` as an array:

```json
[
  {
    "key": "issues",
    "data_source_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "property_ids_by_key": { "title": "title" }
  }
]
```

Replace the example values with the resolved IDs. Check
`ntn workers customblocks make --help`. If it lists `--bindings`, include the
binding array when creating the instance:

```shell
ntn workers customblocks make --key issueBoard --target <page-id-or-url> --bindings @bindings.json --json
```

To add bindings to an instance already created above, use its returned ID as
`--target` instead of the parent page ID.

If `--bindings` is unavailable, use the basic `make` command above, then configure
the returned instance through `ntn api`. Use these endpoints for later updates or
definition defaults too:

| Configure             | Endpoint                                  | Binding array field         |
| --------------------- | ----------------------------------------- | --------------------------- |
| Definition defaults   | `PATCH /v1/custom_block_definitions/{id}` | `data_sources`              |
| Custom block instance | `PATCH /v1/blocks/{id}`                   | `custom_block.data_sources` |
| Custom page instance  | `PATCH /v1/pages/{id}`                    | `custom_page.data_sources`  |
| Custom view instance  | Not yet supported                         | Not yet supported           |

Put the binding array in the indicated field of a JSON request body.
Omit `definition_id` for bindings-only updates.

A supplied array replaces all bindings at that level. Include every binding that
must remain. Omitting instance bindings preserves existing overrides. An empty
instance array clears overrides so definition defaults apply. Legacy saved mappings
may contain encoded IDs that the host resolves without rewriting storage. Do not
decode an ID just because it contains `%`.

An existing definition can also be placed as a custom block instance through
[Notion-flavored Markdown](https://developers.notion.com/custom-blocks/guides/markdown),
including through MCP page tools. These instances inherit definition defaults.
Markdown does not accept instance bindings.

### 7. Share with your teammates

Access to the Worker, instance, data sources, and source code is managed separately.

- **Worker:** Grant **Can connect** to teammates who need to insert instances.
  Grant **Full access** to teammates who need to manage and deploy the Worker.
- **Instance:** Share the containing page. View access lets teammates use the
  block. Edit access also lets them change its bindings.
- **Data sources:** Share every bound data source with the intended viewers.
  Page access does not grant data access. Reads and writes use each viewer's
  permissions.
- **Source code:** Manage access through the repository or other system that
  stores the project. Sharing a Worker does not share its source project.

See [Sharing Workers](https://developers.notion.com/workers/guides/sharing-workers)
and [custom block permissions](https://developers.notion.com/custom-blocks/guides/security#permissions).

## Security

- **Isolation:** Custom blocks run in sandboxed iframes and cannot access Notion's DOM, session, storage, or API credentials. The block's own `localStorage` is shared across instances of the same definition in the same browser profile. `sessionStorage` is shared within the same tab. Neither is shared with Notion or other definitions.
- **Permissions:** Reads and writes use the viewer's permissions. A viewer may be able to load the block but not edit its data, so show a clear message when a write is denied.
- **Data access:** The viewer needs read access to every bound data source before the block can load. Sharing the containing page does not grant that access.
- **Secrets:** Viewers can inspect custom block code. Do not include secrets or API credentials in the frontend bundle.
- **External access:** Workspace approval controls external requests and resources. The destination API must also allow requests from the block's origin through CORS.

See [Security](https://developers.notion.com/custom-blocks/guides/security) for browser restrictions, network policy, and dependency guidance.

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
