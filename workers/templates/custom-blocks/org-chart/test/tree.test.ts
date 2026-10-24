import assert from "node:assert/strict"
import test from "node:test"
import {
  ancestorsOf,
  buildForest,
  chainToRoot,
  layoutForest,
} from "../blocks/org-chart/src/tree"
import type { Person } from "../blocks/org-chart/src/types"

const people: Person[] = [
  { id: "root", name: "Root", role: "CEO", managerIds: [] },
  { id: "lead", name: "Lead", role: "Manager", managerIds: ["root"] },
  { id: "maker", name: "Maker", role: "Designer", managerIds: ["lead"] },
  { id: "cycle-a", name: "Cycle A", role: "", managerIds: ["cycle-b"] },
  { id: "cycle-b", name: "Cycle B", role: "", managerIds: ["cycle-a"] },
]

test("buildForest counts descendants and breaks manager cycles", () => {
  const forest = buildForest(people)

  assert.equal(forest.nodesById.get("root")?.totalCount, 2)
  assert.equal(forest.nodesById.get("lead")?.depth, 1)
  assert.equal(forest.nodesById.get("maker")?.depth, 2)
  assert.equal(forest.roots.length, 2)
  assert.deepEqual(ancestorsOf("maker", forest.parentById), ["lead", "root"])
  assert.deepEqual(
    [...chainToRoot("maker", forest.parentById)],
    ["maker", "lead", "root"]
  )
})

test("layoutForest hides descendants of collapsed nodes", () => {
  const forest = buildForest(people.slice(0, 3))
  const expanded = layoutForest(forest.roots, new Set())
  const collapsed = layoutForest(forest.roots, new Set(["lead"]))

  assert.equal(expanded.positions.size, 3)
  assert.equal(expanded.edges.length, 2)
  assert.equal(collapsed.positions.has("maker"), false)
  assert.deepEqual(collapsed.edges, [{ from: "root", to: "lead" }])
})
