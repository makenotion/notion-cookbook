# Worker Tool: PPT Creator

A Notion worker tool that reads a Notion page and generates a PowerPoint presentation from its content. Each heading becomes a new slide. The `.pptx` file is uploaded and attached as a comment on the page.

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

## Setup

### 1. Install the Notion Workers CLI

```zsh
npm install -g @notionhq/workers-cli
```

### 2. Clone and install

```zsh
# Clone this repository
git clone https://github.com/makenotion/notion-cookbook.git

# Switch into this project
cd notion-cookbook/examples/workers/tools/ppt-creator

# Install dependencies
npm install
```

### 3. Connect to a workspace

```zsh
ntn login
```

### 4. Deploy

```zsh
ntn workers deploy --name ppt-creator
```

After deploying, connect the worker to a custom agent in Notion via **Tools and access > Add connection**.

## Usage

Once connected to an agent, ask it to create a presentation from any page:

> "Create a PowerPoint presentation from this page"

The agent will call the `createPresentation` tool, which reads the page content, generates the slides, and adds the `.pptx` file as a comment.

## Local testing

```zsh
ntn workers exec createPresentation --local -d '{"pageId": "<your-page-id>"}'
```

## Slide design

The presentation uses Notion-inspired styling defined via `defineSlideMaster()`:

- **Title slide** — dark background with large title and accent line
- **Section slide** — warm gray background for headings without body content
- **Content slide** — white background with heading, divider, body area, footer bar, and slide numbers

Inline markdown formatting is preserved: `**bold**` renders as bold and `*italic*` renders as italic in the slides.

## Reading page content

Two approaches are included in `notion.ts`:

| Approach                  | Functions                                     | How it works                                      |
| ------------------------- | --------------------------------------------- | ------------------------------------------------- |
| **Markdown API** (active) | `getPageMarkdown` + `groupMarkdownIntoSlides` | Single API call, parses markdown string           |
| **Block API** (available) | `getAllBlocks` + `groupBlocksIntoSlides`      | Paginated block fetching, switches on block types |

Switch between them by changing the imports in `index.ts`.
