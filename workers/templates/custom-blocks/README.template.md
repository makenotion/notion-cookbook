# {{title}}

Build your own interface inside Notion with this template.

## Prerequisites

- Node.js 22+ and npm 10+.
- The [Notion CLI (`ntn`)](https://developers.notion.com/cli/get-started/installation).
- A Notion workspace.
- A Notion web host that supports custom-block initialization protocol 12.

This template pins `@notionhq/custom-blocks` 0.6.0 and
`@notionhq/custom-blocks-dev-shell` 0.4.0. These versions are matched to the
protocol 12 host support. Native mobile custom-block hosts are not supported by
this SDK release.

## Set up

pnpm is recommended for new projects; npm also works.

From this template’s directory, install dependencies:

```sh
pnpm install
```

## Develop locally

Use the dev shell to verify changes locally with sample data before you deploy:

```sh
ntn workers customblocks dev
```

Open the shell URL printed by the command. See the documentation in
`@notionhq/custom-blocks-dev-shell` for more details. The local dev shell uses
the SDK and host versions pinned in this template.

## SDK entry points

Import React components and hooks from `@notionhq/custom-blocks/react`.
Framework-neutral APIs use domain subpaths such as
`@notionhq/custom-blocks/pages` and
`@notionhq/custom-blocks/data-sources`.

For example, create a local page reference and then request its data:

```ts
import { initCustomBlock } from "@notionhq/custom-blocks"
import { NotionPage } from "@notionhq/custom-blocks/pages"

await initCustomBlock()

async function inspectPage(pageKey: string) {
  // Under protocol 12, page keys currently use raw page IDs.
  const page = NotionPage.fromKey(pageKey)
  const result = await page.get()
  if (result.status === "success") {
    console.log(result.page.pageKey)
  }
}
```

Reference construction does not initialize the SDK or perform host I/O. Use
`<NotionCustomBlock>` in React or await `initCustomBlock()` before making
asynchronous reads. Check each operation's `status` result.

The protocol 12 SDK currently maps page keys to raw page IDs at the wire
boundary. See the domain documentation shipped in
`@notionhq/custom-blocks/docs` for current limits and result types.

## Deploy and share

Deploy the block to use it in Notion:

```sh
ntn login
{{deployCommand}}
```

Insert the deployed block into a page, then share the page so others can use the
block. Deploy again to publish later changes.

## Agent instructions

The full custom block guide ships in `@notionhq/workers`. The custom-blocks
skill included with this template links that guide to the matching SDK domain
documentation.
