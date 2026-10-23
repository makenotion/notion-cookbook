import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { StageChip } from "../blocks/shared/Properties.tsx"
import { stageColorsFor, stagesFor } from "../blocks/shared/model.ts"

test("chips honor configured option colors independently of option names", () => {
  const colors = stageColorsFor(
    stagesFor(
      {
        name: "Stage",
        type: "select",
        options: [
          { id: "a", name: "Release ready", color: "purple_background" },
          { id: "b", name: "Done", color: "red" },
        ],
      },
      []
    )
  )

  assert.match(
    renderToStaticMarkup(
      createElement(StageChip, { name: "Release ready", colors })
    ),
    /data-bg-theme="purple" data-content-theme="purple">Release ready</
  )
  assert.match(
    renderToStaticMarkup(createElement(StageChip, { name: "Done", colors })),
    /data-bg-theme="red" data-content-theme="red">Done</
  )
})

test("status defaults and unknown colors use a neutral chip theme", () => {
  const colors = stageColorsFor([
    ...stagesFor(
      {
        name: "Stage",
        type: "status",
        groups: [],
        options: [
          { id: "a", name: "Unscheduled", color: "default_background" },
          { id: "b", name: "In progress" },
        ],
      },
      []
    ),
    { name: "Future option", color: "unsupported_background" },
  ])

  assert.match(
    renderToStaticMarkup(
      createElement(StageChip, { name: "Unscheduled", colors })
    ),
    /data-bg-theme="gray" data-content-theme="gray"/
  )
  assert.match(
    renderToStaticMarkup(
      createElement(StageChip, { name: "In progress", colors })
    ),
    /data-bg-theme="gray" data-content-theme="gray"/
  )
  assert.match(
    renderToStaticMarkup(
      createElement(StageChip, { name: "Future option", colors })
    ),
    /data-bg-theme="gray" data-content-theme="gray"/
  )
  assert.match(
    renderToStaticMarkup(
      createElement(StageChip, { name: "Unrecognized row value", colors })
    ),
    /data-bg-theme="gray" data-content-theme="gray"/
  )
})
