---
name: custom-blocks
description: Build and troubleshoot custom blocks inside Notion. Use the SDK's current domain APIs, React integration, and host compatibility requirements.
user-invocable: false
---

# Custom blocks

Before creating, modifying, or troubleshooting a custom block, read
`node_modules/@notionhq/workers/skills/custom-blocks/SKILL.md`. Resolve this
path relative to the Worker project root. Follow its project setup and
deployment guidance.

For SDK behavior, read the matching guide shipped in
`node_modules/@notionhq/custom-blocks/docs/`: start with `lifecycle.md`,
then use `pages.md`, `data-sources.md`, `users.md`, or `errors.md` for the
domain you are changing.

## Current SDK and host support

The custom-block templates pin `@notionhq/custom-blocks` 0.6.0 and
`@notionhq/custom-blocks-dev-shell` 0.4.0. SDK 0.6.0 uses initialization
protocol 12. It requires a Notion web host that supports protocol 12; native
mobile custom-block hosts are not supported by this SDK release.

Do not use a package's newest release as a substitute for checking its
compatibility with the host. Keep SDK and dev-shell pins aligned with the
supported host version.

## SDK usage

- Import React components and hooks from `@notionhq/custom-blocks/react`.
- Import framework-neutral APIs from their domain subpaths:
  `/context`, `/appearance`, `/pages`, `/users`, `/data-sources`, and
  `/navigation`.
- Use `<NotionCustomBlock>` or call `initCustomBlock()` before reading host
  data. Reference factories such as `NotionPage.fromKey(key)` are local and do
  not initialize the SDK or perform I/O.
- Check each asynchronous operation's `status` result. Do not treat an
  uninitialized read as an empty value or assume query rows are loaded page
  data; call `page.get()` or use the React `usePage(page)` hook.
- Protocol 12 temporarily sends page keys as raw page IDs. Do not claim that
  arbitrary configured page-key aliases are supported by the wire protocol.
- User field getters currently use a whole-profile protocol 12 read, which
  includes the email field. Field-level reads and grants are not enforced by
  this protocol.

If the Worker skill is missing, install the project dependencies. If it remains
missing, update `@notionhq/workers` to a release that includes the skill. Do
not continue with custom-block changes until you can read the SDK guidance.
