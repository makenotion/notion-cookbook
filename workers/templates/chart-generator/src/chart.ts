import { join } from "node:path"
import type { TopLevelSpec } from "vega-lite"

// Bundled with the worker — the build step copies src/fonts to dist/fonts.
const FONT_PATH = join(__dirname, "fonts", "inter.ttf")

// Clamp so an agent can't request an enormous render. Default 2 (retina).
export function clampScaleFactor(value: number | null): number {
  if (value == null || !Number.isFinite(value)) return 2
  return Math.min(Math.max(value, 1), 5)
}

// vega / vega-lite / @resvg are imported dynamically on purpose: vega 6's
// vega-canvas has a top-level `await import("canvas")`, and the worker platform
// discovers capabilities with require(), which throws ERR_REQUIRE_ASYNC_MODULE
// on a static import. A dynamic import defers the load to execution time.
export async function renderVegaLiteToPng(
  spec: TopLevelSpec,
  scaleFactor: number
): Promise<Buffer> {
  const { compile } = await import("vega-lite")
  const { View, parse } = await import("vega")
  const { Resvg } = await import("@resvg/resvg-js")

  const vegaSpec = compile(spec).spec
  const view = new View(parse(vegaSpec), { renderer: "none" })
  let svg: string
  try {
    svg = await view.toSVG()
  } finally {
    // Always release the view, even if rendering throws.
    view.finalize()
  }

  const resvg = new Resvg(svg, {
    fitTo: { mode: "zoom" as const, value: scaleFactor },
    font: {
      fontFiles: [FONT_PATH],
      loadSystemFonts: false,
      defaultFontFamily: "Inter",
      sansSerifFamily: "Inter",
    },
  })
  return resvg.render().asPng()
}
