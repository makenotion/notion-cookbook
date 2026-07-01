# Worker tool: Chart generator

**TL;DR:** Let a Notion agent turn data into a polished chart and place the image directly on a page.

## Quickstart

This worker needs no external credentials. Notion authenticates each deployed agent call automatically.

From the repository root:

```zsh
npm install --global ntn
cd workers/chart-generator
npm install
ntn login
ntn workers deploy --name chart-generator
```

In Notion, add the deployed worker to a custom agent under **Tools and access > Add connection**.

## Try asking

- "Make a bar chart of A=28, B=55, and C=43, then add it to this page."
- "Turn this quarterly revenue table into a line chart and place it below the table."
- "Create a donut chart from these support-ticket totals and add it to my report."

The agent uses two tools:

- `generateChart` — render a Vega-Lite spec to a PNG and upload it; returns a `fileUploadId`.
- `insertImage` — append that uploaded image as a block on a page (optionally after a specific block).

A custom agent chains them: turn data into a spec, render it, drop it on the page.

## How it works

1. `generateChart` parses a Vega-Lite v6 JSON spec, compiles it (vega-lite), renders it to SVG (vega), and rasterizes that to PNG (`@resvg/resvg-js`) using a bundled Inter font.
2. It uploads the PNG with the pre-authenticated Notion client (`context.notion.fileUploads`) and returns the `fileUploadId`.
3. `insertImage` appends an `image` block referencing that upload via `context.notion.blocks.children.append`.

Because the tools use the client Notion hands to each invocation, there's no API URL or token to configure for the deployed worker — agent calls are authenticated automatically.

## Project structure

```
src/
  index.ts   — the two tools (generateChart, insertImage)
  chart.ts   — Vega-Lite to PNG rendering
  notion.ts  — parse a UUID or Notion URL into a bare ID
  fonts/
    inter.ttf — bundled font for chart text (SIL Open Font License)
```

## Run locally

The render path needs no Notion connection:

```zsh
npm test
```

To exercise the full upload/insert flow locally, the runtime needs a token (deployed agent calls get one automatically). Create an [internal integration](https://www.notion.so/profile/integrations/internal), give it access to a page, add `NOTION_API_TOKEN=...` to a local `.env` (gitignored), then:

```zsh
ntn workers exec generateChart --local -d '{"spec": "<vega-lite json>", "scaleFactor": 2}'
ntn workers exec insertImage  --local -d '{"fileUploadId": "<id>", "parent": "<page url or id>", "afterBlockId": null}'
```

## Notes

- The Inter font (SIL Open Font License) is bundled so charts render consistently without relying on system fonts.
- `scaleFactor` is clamped to 1–5 (default 2) to keep image sizes reasonable.
- The chart is added as an image block in the page body — not a custom block or database view.

## Learn more

- [Notion Workers documentation](https://developers.notion.com/docs/workers)
- [Vega-Lite documentation](https://vega.github.io/vega-lite/)
- [Contribute to this cookbook](../../CONTRIBUTING.md)
