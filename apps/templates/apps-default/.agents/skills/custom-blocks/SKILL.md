---
name: custom-blocks
description: Build interactive browser custom blocks declared by a Notion App.
user-invocable: false
---

# App custom blocks

Import `Notion` from the package root and default-export `Notion.customBlock(...)` in
`src/customBlocks/<key>.ts`. Copy the existing hello block's browser setup:

```ts
import * as Notion from "@notionhq/apps"

export default Notion.customBlock({
  path: "./blocks/issueBoard",
  slashCommand: "issue-board",
  dataSources: {},
})
```

Paths are relative to the app root. Keep browser source in `blocks/<key>/`
with its own Vite config and browser tsconfig. The root package owns React,
React DOM, Vite, and type dependencies. The default build command is
`npx vite build` and output directory is `dist`; override `command` and
`output` when needed. For existing browser assets use `static: true`, which
cannot be combined with `command` or `output`.

Import React integration from `@notionhq/apps/react` and styles from
`@notionhq/apps/nds.css`. Wrap the UI in `NotionCustomBlock`. Read the installed
custom-block client documentation before adding hooks or host interactions.
Browser runtime APIs stay on `@notionhq/apps/custom-blocks`; the root
`Notion.customBlock` creates a capability, not a browser runtime client.
Never put server credentials in browser source.

`dataSources` declares expected host schemas; it does not bind a concrete
database. Inspect `ManifestDataSource` from the installed custom-blocks package.
These schemas use Notion API property names such as `rich_text`; Notion as Code
data source properties use a different representation, such as `text`.

Blocks are build-time declarations, not executable workflow handlers. Do not
port `worker.customBlock()`, Worker source options, or Worker execution commands.
Run the app's browser typecheck and build. Inspect installed Apps CLI help for
block build commands, and verify rendering and bindings in an available host
when requested; a server bundle build alone does not test browser behavior.
