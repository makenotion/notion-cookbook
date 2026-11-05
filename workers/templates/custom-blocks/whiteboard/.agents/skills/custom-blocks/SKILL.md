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
- **Query results:** Query results are limited to 1,000 rows. There is no offset pagination.
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

Use the [dev shell](https://developers.notion.com/custom-blocks/guides/preview)
to test the custom block with local sample data:

```shell
ntn workers customblocks dev -- --json
```

The command emits startup JSON and keeps running. Open its `shellUrl` to test
the block, rather than the frontend URL directly.

The dev shell builds the Worker and runs the frontend locally with hot reload.
It creates and binds empty sample databases for declared data sources. Add rows
manually or use `ntn workers customblocks sample` to sample an existing database.
Check rendering and the main interaction. Restart the dev shell after changing
the Worker declaration so it rebuilds the manifest.

In React blocks, press `\` to toggle the SDK debug console. Report what was
tested and any checks that could not be completed. The dev shell uses a mock
host. It does not verify production permissions or sandbox behavior.

### 5. Deploy the Worker

Deploy only when the user asks for a live deployment:

```shell
ntn workers deploy
```

Normal deployment builds the Worker and frontend remotely using the declared
build command. Do not use `ntn workers exec` for a custom block. It has no
`execute` handler.

### 6. Create and connect an instance

Every declared data source needs a binding before the block can initialize.
Set bindings on the definition for instances to inherit, or on an individual
instance to override its defaults.

Resolve each database with `ntn datasources resolve <database-id>` and read its
schema with `ntn api v1/data_sources/<data-source-id>`. Map declared keys to the
actual data source and property IDs. Pass property IDs exactly as returned by
the schema.

Run `ntn workers customblocks make --help` before choosing the command. If it
lists `--bindings`, prepare the binding array described in
[Instance bindings](reference/instance-bindings.md), then run from the deployed
Worker root:

```shell
ntn workers customblocks make --key issueBoard --target <page-id-or-url> --bindings @bindings.json --json
```

`--key` selects the deployed definition. `--target` places an inline instance
under a page or block, or configures an existing custom instance. Omit it to
create a private custom page. Preserve the returned instance ID and URL.

A supplied binding array replaces all instance overrides. Omit `--bindings` to
preserve them, or use `--bindings '[]'` to clear them and inherit definition
defaults. If `--bindings` is unavailable, run `make` without it and configure the
returned instance through the API. See [Instance bindings](reference/instance-bindings.md)
for request shapes and later updates.

An existing definition can also be placed inline through
[Notion-flavored Markdown](https://developers.notion.com/custom-blocks/guides/markdown),
including through MCP page tools. These instances inherit the definition's
bindings. Markdown does not accept instance bindings. Custom database views are
not supported by this CLI/Public API flow.

Report any permission, feature-gate, or configuration failure instead of claiming
setup is complete.

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

Use the custom blocks SDK for Notion data access.
Do not call the Notion API or host bridge directly from the iframe.

### Sandbox

Each block runs in a sandboxed iframe. It cannot access Notion's DOM,
cookies, storage, session, or API credentials.

- Workspace owners can approve HTTPS origins for external requests and resources.
  Bundle JavaScript dependencies. External scripts remain blocked.
- Notion-hosted media and Google Fonts work without workspace approval.
- Browser workers, form submissions, popups, top-level navigation, and content
  loaded through `<object>` or `<embed>` are blocked. Use the SDK's `pages.open`
  for Notion pages and `links.open` for external links.
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
Page guests can view custom blocks if they can access the containing page and
every bound data source. Notion Sites does not render custom blocks.

Only trust custom blocks from trusted authors. Malicious blocks can copy private viewer data
to pages or data sources their authors can read.

### Secrets and dependencies

Viewers can inspect the frontend bundle.
Exclude secrets, tokens, and private URLs from the bundle.
Store secrets in the Worker on the server.

Review third-party dependencies. Pin trusted versions.
Build tools can access the Worker project despite runtime network restrictions.

See [Security](https://developers.notion.com/custom-blocks/guides/security).

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
