import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"
import {
  extractPageId,
  getPageTitle,
  getPageMarkdown,
  groupMarkdownIntoSlides,
  uploadToNotion,
} from "./notion.js"
import { buildPresentation } from "./presentation.js"

const worker = new Worker()
export default worker

worker.tool("createPresentation", {
  title: "Create Presentation",
  description:
    "Reads a Notion page and creates a PowerPoint presentation from its content. Each heading becomes a new slide. The generated .pptx file is added as a comment on the page.",
  schema: j.object({
    pageId: j
      .string()
      .describe("The Notion page ID or URL to convert into a presentation"),
  }),
  execute: async ({ pageId: rawPageId }, { notion }) => {
    const pageId = extractPageId(rawPageId)

    const pageTitle = await getPageTitle(notion, pageId)

    // Fetch page content as markdown and parse into slides
    const markdown = await getPageMarkdown(pageId)
    const slides = groupMarkdownIntoSlides(markdown, pageTitle)

    // Build the .pptx file
    const filename = `${pageTitle}.pptx`
    const buffer = await buildPresentation(pageTitle, slides)

    // Upload and attach as a page comment
    const slideCount = slides.length + 1
    const message = `Generated presentation with ${slideCount} slides from this page.`
    await uploadToNotion(pageId, filename, buffer, message)

    return `Created "${filename}" (${slideCount} slides) and added it as a comment on the page.`
  },
})
