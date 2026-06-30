# Worker tool: Chart generator

A Notion worker that renders a [Vega-Lite](https://vega.github.io/vega-lite/) chart to an image and embeds it in a Notion page. It registers two tools:

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

## Setup

### 1. Install the Notion Workers CLI

```zsh
npm install --global ntn
```

### 2. Clone and install

```zsh
git clone https://github.com/makenotion/notion-cookbook.git
cd notion-cookbook/workers/chart-generator
npm install
```

### 3. Connect to your workspace

```zsh
ntn login
```

### 4. Deploy

```zsh
ntn workers deploy --name chart-generator
```

After deploying, connect the worker to a custom agent in Notion via **Tools and access > Add connection**.

## Usage

Ask the agent to chart some data and add it to a page:

> "Make a bar chart of A=28, B=55, C=43 and add it to this page."

The agent calls `generateChart` (which returns a `fileUploadId`) and then `insertImage` to embed it.

## Local testing

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
