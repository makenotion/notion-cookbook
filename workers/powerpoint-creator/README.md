# Worker tool: PowerPoint creator

**TL;DR:** Turn a Notion page into PowerPoint slides and export them as a
ready-to-download `.pptx` presentation. The worker uses headings to organize
slides, preserves common text formatting, and attaches the generated file to
the source page as a comment.

## Quickstart

This worker needs no external credentials. Notion authenticates each deployed
agent call automatically.

From the repository root:

```zsh
npm install --global ntn
cd workers/powerpoint-creator
npm install
ntn login
ntn workers deploy --name powerpoint-creator
```

In Notion, add the deployed worker to a custom agent under
**Tools and access > Add connection**.

## Try asking

- "Create a PowerPoint presentation from this page."
- "Turn this project brief into PowerPoint slides and attach the `.pptx` file."
- "Export this meeting-notes page as a PowerPoint `.pptx` presentation."

The agent calls `createPresentation`, then adds the generated file to the source
page as a comment.

## How it works

1. **Reads** the page title and content via the [Notion Markdown API](https://developers.notion.com/reference/get-page-markdown)
2. **Parses** the markdown into slides — headings start new slides, content underneath (paragraphs, bullets, numbered lists, to-dos, code, quotes) becomes slide body
3. **Generates** a `.pptx` file using [pptxgenjs](https://github.com/gitbrent/PptxGenJS) with Notion-inspired styling
4. **Uploads** the file via the [Notion File Upload API](https://developers.notion.com/reference/file-uploads) and attaches it as a page comment

## Project structure

```
src/
  index.ts          — Worker tool definition
  types.ts          — Slide and content types
  theme.ts          — Notion-inspired color and font theme
  notion.ts         — Notion API helpers (read page, parse markdown, upload file)
  presentation.ts   — pptxgenjs slide builder with slide masters
```

## Run locally

Local execution needs a Notion internal integration token with access to the
source page. Put `NOTION_API_TOKEN=...` in an untracked `.env` file, then run:

```zsh
ntn workers exec createPresentation --local -d '{"pageId": "<your-page-id>"}'
```

## Slide design

The presentation uses Notion-inspired styling defined via `defineSlideMaster()`:

- **Title slide** — dark background with large title and accent line
- **Section slide** — warm gray background for headings without body content
- **Content slide** — white background with heading, divider, body area, footer bar, and slide numbers

Inline markdown formatting is preserved: `**bold**` renders as bold and
`*italic*` renders as italic in the slides.
