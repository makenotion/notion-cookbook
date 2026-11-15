<!-- Generated from workers/templates/custom-blocks/icon-picker/README.template.md. Run npm run agents:sync to update. -->

> This currently doesn't work with released packages. It needs changes to land in the Notion app and custom blocks SDK first.

# Icon picker

Search Notion's icon catalog, choose a color, and preview the result in a custom
block. The reusable controlled React `IconPicker` reports selections to its
consumer. The separate demo can apply a selection to the block's containing page
and read it back from Notion.

No integration token, external service, or database binding is needed. Choosing an
icon only changes the preview. **Apply to this page** changes the containing
page's native icon; it does not change a database property icon.

## Prerequisites

- Node.js 22.23.4+ and npm 10.9.9+.
- The [Notion CLI (`ntn`)](https://developers.notion.com/cli/get-started/installation).
- A workspace with custom blocks enabled and an editable page for the demo.
- Development builds of Notion, the custom blocks SDK, and the Workers SDK that
  support icon listing, ranked search, and native definition icons. The package
  ranges follow the other templates and need updating when support is released.

## Set up and verify

From this template's directory:

```sh
npm install
npm run check
npm test
npm run build
```

With matching development packages, `check` typechecks the Worker and frontend, `test` runs
deterministic grid-navigation tests, and `build` compiles both entrypoints.

## Develop locally

```sh
ntn workers customblocks dev
```

Open the printed URL. The dev shell is a reference host; its catalog and page
behavior can differ from Notion. Use an editable test page in a compatible Notion
development build to verify saving. Connect the preview through **Set up custom
block → Develop locally → Enable → Connect**.

Open **Change icon**, search **star circle** to find `token`, or **delivery truck**
to find `truck`. Change colors and select an icon, then explicitly apply it. The
saved message appears only after a fresh page read confirms the name and color.
Reconnecting reads the saved native icon again. A connection interruption may
require the host's **Try again** action.

## Deploy when supported packages are available

Once compatible packages and Notion support are available, update the dependencies,
run the checks above, then:

```sh
ntn login
ntn workers deploy --name icon-picker
ntn workers customblocks make --key iconPicker --target <page-id-or-url>
```

Use an editable test page as the target. No data sources or environment variables
need configuring. Deploy again to publish later changes.

## Reuse the controlled picker

```tsx
import { useState } from "react"
import { IconPicker, type IconSelection } from "./IconPicker"

function MyView() {
  const [value, setValue] = useState<IconSelection>({
    name: "token",
    color: "purple",
  })
  return <IconPicker value={value} onChange={setValue} />
}
```

Render it inside the SDK's `NotionCustomBlock` and `NotionTokenScope`, and load
`@notionhq/custom-blocks/nds.css`, as shown in `blocks/icon-picker/src/index.tsx`.
Copy the picker, grid, selection, glyph, and picker CSS files together. The value
uses a canonical host-provided name and one of ten supported SVG colors.

- `IconPicker.tsx` owns open/close, catalog/search, loading, empty/error/unsupported
  states, retry, colors, and ignoring outdated query responses. It never accesses pages.
- `IconGrid.tsx` provides native buttons with roving Tab focus, arrows, Home, and End.
  Escape closes the picker and returns focus to its trigger.
- `Demo.tsx` owns the controlled value and page get/update/get flow. **Reset selection**
  demonstrates changing the value from the consumer without writing to Notion.
- `SelectionPreview.tsx` renders the consumer's live preview and saved/error state.
- `selection.ts` contains color metadata and keyboard navigation. Icon names always
  come from `icon.list()` or ranked `icon.query()`; no catalog is bundled.
- `src/index.ts` declares the standalone Worker and its purple native `token` icon.

Keep persistence in your consumer: store a selection in application state, apply it
to a page after confirmation, or use it as another control's value. Use
`getNotionIconUrl()` for public SVG images; no token belongs in frontend code.

## Verification

The template was verified in a Notion development build with the full catalog,
ranked search, all ten color controls, rapid queries, keyboard focus, explicit
apply/readback, and reconnect persistence. Screen-reader and native mobile behavior
still need verification. The offline tests cover navigation bounds and native keys.

Agent files and this README are generated with the repository's
`npm run agents:sync`; edit `README.template.md` for recipe-specific instructions.
