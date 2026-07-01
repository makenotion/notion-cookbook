import pptxgen from "pptxgenjs"
import { THEME } from "./theme.js"
import type { Slide, SlideItem } from "./types.js"

function parseItalic(
  text: string,
  baseOptions: pptxgen.TextPropsOptions
): pptxgen.TextProps[] {
  const runs: pptxgen.TextProps[] = []
  const parts = text.split(/(\*[^*]+\*)/g)

  for (const part of parts) {
    if (!part) continue
    if (part.startsWith("*") && part.endsWith("*")) {
      runs.push({
        text: part.slice(1, -1),
        options: { ...baseOptions, italic: true },
      })
    } else {
      runs.push({ text: part, options: { ...baseOptions } })
    }
  }

  return runs
}

function parseInlineMarkdown(
  text: string,
  baseOptions: pptxgen.TextPropsOptions
): pptxgen.TextProps[] {
  const runs: pptxgen.TextProps[] = []
  const parts = text.split(/(\*\*[^*]+\*\*)/g)

  for (const part of parts) {
    if (!part) continue
    if (part.startsWith("**") && part.endsWith("**")) {
      runs.push({
        text: part.slice(2, -2),
        options: { ...baseOptions, bold: true },
      })
    } else {
      runs.push(...parseItalic(part, baseOptions))
    }
  }

  if (runs.length === 0) {
    runs.push({ text, options: { ...baseOptions } })
  }

  return runs
}

function itemToTextRuns(item: SlideItem): pptxgen.TextProps[] {
  const baseFont: pptxgen.TextPropsOptions = {
    fontFace: THEME.font,
    fontSize: 15,
    color: THEME.text,
  }

  const paraOptions: pptxgen.TextPropsOptions = {
    paraSpaceAfter: 6,
  }

  let text = item.text

  switch (item.type) {
    case "bullet":
      paraOptions.bullet = true
      paraOptions.indentLevel = 0
      break
    case "numbered":
      paraOptions.bullet = { type: "number" }
      paraOptions.indentLevel = 0
      break
    case "todo":
      text = `${item.checked ? "☑" : "☐"}  ${text}`
      break
    case "quote":
      baseFont.italic = true
      baseFont.color = THEME.textLight
      paraOptions.paraSpaceAfter = 10
      break
    case "code":
      baseFont.fontFace = THEME.monoFont
      baseFont.fontSize = 12
      baseFont.color = THEME.textLight
      baseFont.highlight = THEME.codeBg
      break
    case "text":
      paraOptions.paraSpaceAfter = 12
      break
  }

  const runs = parseInlineMarkdown(text, baseFont)

  runs[0].options = { ...runs[0].options, ...paraOptions }
  runs[runs.length - 1].options = {
    ...runs[runs.length - 1].options,
    breakLine: true,
  }

  return runs
}

function defineMasters(pres: pptxgen): void {
  pres.defineSlideMaster({
    title: "TITLE_SLIDE",
    background: { color: THEME.titleBg },
    objects: [
      {
        rect: {
          x: 0.8,
          y: 3.6,
          w: 1.2,
          h: 0.05,
          fill: { color: THEME.accent },
        },
      },
      {
        placeholder: {
          options: {
            name: "title",
            type: "title",
            x: 0.8,
            y: 1.2,
            w: 8.4,
            h: 2.2,
            fontFace: THEME.font,
            fontSize: 40,
            color: THEME.bg,
            bold: true,
            align: "left",
            valign: "bottom",
          },
        },
      },
      {
        placeholder: {
          options: {
            name: "subtitle",
            type: "body",
            x: 0.8,
            y: 3.9,
            w: 8.4,
            h: 0.6,
            fontFace: THEME.font,
            fontSize: 16,
            color: THEME.textLight,
            align: "left",
          },
        },
      },
    ],
  })

  pres.defineSlideMaster({
    title: "SECTION_SLIDE",
    background: { color: THEME.bgWarm },
    objects: [
      {
        rect: {
          x: 0,
          y: 0,
          w: 0.06,
          h: "100%",
          fill: { color: THEME.accent },
        },
      },
      {
        placeholder: {
          options: {
            name: "title",
            type: "title",
            x: 0.8,
            y: 1.8,
            w: 8.4,
            h: 1.5,
            fontFace: THEME.font,
            fontSize: 32,
            color: THEME.text,
            bold: true,
            align: "left",
            valign: "middle",
          },
        },
      },
    ],
  })

  pres.defineSlideMaster({
    title: "CONTENT_SLIDE",
    background: { color: THEME.bg },
    objects: [
      {
        rect: {
          x: 0,
          y: 0,
          w: 0.06,
          h: "100%",
          fill: { color: THEME.accent },
        },
      },
      {
        rect: {
          x: 0.6,
          y: 1.05,
          w: 8.9,
          h: 0.01,
          fill: { color: THEME.divider },
        },
      },
      {
        rect: {
          x: 0,
          y: 5.1,
          w: "100%",
          h: 0.525,
          fill: { color: THEME.bgWarm },
        },
      },
      {
        placeholder: {
          options: {
            name: "header",
            type: "title",
            x: 0.6,
            y: 0.2,
            w: 8.9,
            h: 0.75,
            fontFace: THEME.font,
            fontSize: 24,
            color: THEME.text,
            bold: true,
            valign: "bottom",
          },
        },
      },
      {
        placeholder: {
          options: {
            name: "body",
            type: "body",
            x: 0.6,
            y: 1.2,
            w: 8.9,
            h: 3.7,
            fontFace: THEME.font,
            fontSize: 15,
            color: THEME.text,
            valign: "top",
          },
        },
      },
    ],
    slideNumber: {
      x: 9.2,
      y: 5.2,
      color: THEME.textLight,
      fontSize: 9,
      fontFace: THEME.font,
    },
  })
}

export async function buildPresentation(
  title: string,
  slides: Slide[]
): Promise<Buffer> {
  const pres = new pptxgen()
  pres.title = title
  pres.layout = "LAYOUT_16x9"

  defineMasters(pres)

  // Title slide
  const titleSlide = pres.addSlide({ masterName: "TITLE_SLIDE" })
  titleSlide.addText(title, { placeholder: "title" })

  // Content slides
  for (const slide of slides) {
    if (slide.items.length === 0) {
      // Section break slide for headings with no content
      const s = pres.addSlide({ masterName: "SECTION_SLIDE" })
      s.addText(slide.title, { placeholder: "title" })
    } else {
      const s = pres.addSlide({ masterName: "CONTENT_SLIDE" })
      s.addText(slide.title, { placeholder: "header" })
      s.addText(slide.items.flatMap(itemToTextRuns), {
        placeholder: "body",
      })
    }
  }

  return (await pres.write({ outputType: "nodebuffer" })) as Buffer
}
