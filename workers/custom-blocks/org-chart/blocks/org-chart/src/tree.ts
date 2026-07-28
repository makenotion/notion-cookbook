import type { Person } from "./types"

export const CARD_W = 176
export const CARD_H = 122
export const SIBLING_GAP = 24
export const RANK_GAP = 48
export const TREE_GAP = 64

export type OrgNode = {
  person: Person
  children: OrgNode[]
  depth: number
  directCount: number
  totalCount: number
}

export type Forest = {
  roots: OrgNode[]
  nodesById: Map<string, OrgNode>
  parentById: Map<string, string | null>
}

/**
 * Build a forest from flat rows. Roots are people whose manager relation is
 * empty or points outside the row set. Cycles are broken by cutting the
 * manager edge of one member of the cycle, which surfaces it as a root.
 */
export function buildForest(people: Person[]): Forest {
  const byId = new Map<string, Person>(people.map((p) => [p.id, p]))
  const managerOf = new Map<string, string | null>()
  for (const p of people) {
    const m = p.managerIds.find((id) => id !== p.id && byId.has(id)) ?? null
    managerOf.set(p.id, m)
  }

  // Cycle detection: walk up the manager chain from every person; if the walk
  // revisits a node before reaching a known-safe node, cut that node's edge.
  const safe = new Set<string>()
  for (const p of people) {
    const path: string[] = []
    const onPath = new Set<string>()
    let cur: string | null = p.id
    while (cur !== null && !safe.has(cur)) {
      if (onPath.has(cur)) {
        managerOf.set(cur, null)
        break
      }
      onPath.add(cur)
      path.push(cur)
      cur = managerOf.get(cur) ?? null
    }
    for (const id of path) safe.add(id)
  }

  const nodesById = new Map<string, OrgNode>()
  for (const p of people) {
    nodesById.set(p.id, {
      person: p,
      children: [],
      depth: 0,
      directCount: 0,
      totalCount: 0,
    })
  }
  const roots: OrgNode[] = []
  for (const p of people) {
    const node = nodesById.get(p.id)!
    const m = managerOf.get(p.id)
    if (m === null || m === undefined) {
      roots.push(node)
    } else {
      nodesById.get(m)!.children.push(node)
    }
  }

  // Depths + descendant counts (iterative post-order to be safe on deep chains).
  for (const root of roots) {
    const stack: Array<{ node: OrgNode; visited: boolean }> = [
      { node: root, visited: false },
    ]
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (!top.visited) {
        top.visited = true
        for (const child of top.node.children) {
          child.depth = top.node.depth + 1
          stack.push({ node: child, visited: false })
        }
      } else {
        stack.pop()
        top.node.directCount = top.node.children.length
        top.node.totalCount = top.node.children.reduce(
          (sum, c) => sum + c.totalCount + 1,
          0
        )
      }
    }
  }

  // Larger trees first so the primary org reads first; stable for ties.
  roots.sort((a, b) => b.totalCount - a.totalCount)

  const parentById = new Map<string, string | null>()
  for (const p of people) parentById.set(p.id, managerOf.get(p.id) ?? null)

  return { roots, nodesById, parentById }
}

export type LayoutResult = {
  /** Top-left corner of each visible card, in world coordinates. */
  positions: Map<string, { x: number; y: number }>
  /** Visible parent→child edges. */
  edges: Array<{ from: string; to: string }>
  width: number
  height: number
}

/** Per-depth horizontal extent of a subtree, relative to the subtree origin. */
type Extent = Array<{ l: number; r: number }>

function fitShift(left: Extent, right: Extent): number {
  let shift = 0
  const n = Math.min(left.length, right.length)
  for (let d = 0; d < n; d++) {
    shift = Math.max(shift, left[d].r + SIBLING_GAP - right[d].l)
  }
  return shift
}

function mergeExtents(a: Extent, b: Extent, shift: number): Extent {
  const out: Extent = []
  const n = Math.max(a.length, b.length)
  for (let d = 0; d < n; d++) {
    const ae = a[d]
    const be = b[d]
    if (ae && be) {
      out.push({
        l: Math.min(ae.l, be.l + shift),
        r: Math.max(ae.r, be.r + shift),
      })
    } else if (ae) {
      out.push({ l: ae.l, r: ae.r })
    } else {
      out.push({ l: be.l + shift, r: be.r + shift })
    }
  }
  return out
}

type SubtreeMeta = {
  /** x of the node's left edge, relative to the subtree origin. */
  nodeX: number
  /** Origin of each visible child's subtree, relative to this subtree origin. */
  childOrigins: number[]
  extent: Extent
}

/**
 * Tidy tree layout (Reingold–Tilford style via per-depth extent merging):
 * post-order pass computes each subtree's horizontal extent, siblings are
 * packed against the accumulated contour, and parents are centered over the
 * midpoint of their first and last children.
 */
export function layoutForest(
  roots: OrgNode[],
  collapsed: Set<string>
): LayoutResult {
  const positions = new Map<string, { x: number; y: number }>()
  const edges: Array<{ from: string; to: string }> = []
  const metaById = new Map<string, SubtreeMeta>()
  const rankH = CARD_H + RANK_GAP

  function visibleChildren(node: OrgNode): OrgNode[] {
    return collapsed.has(node.person.id) ? [] : node.children
  }

  function measure(node: OrgNode): Extent {
    const kids = visibleChildren(node)
    if (kids.length === 0) {
      const meta: SubtreeMeta = {
        nodeX: 0,
        childOrigins: [],
        extent: [{ l: 0, r: CARD_W }],
      }
      metaById.set(node.person.id, meta)
      return meta.extent
    }
    let merged: Extent | null = null
    const childOrigins: number[] = []
    for (const child of kids) {
      const ext = measure(child)
      if (merged === null) {
        childOrigins.push(0)
        merged = ext.map((e) => ({ l: e.l, r: e.r }))
      } else {
        const shift = fitShift(merged, ext)
        childOrigins.push(shift)
        merged = mergeExtents(merged, ext, shift)
      }
    }
    const firstMeta = metaById.get(kids[0].person.id)!
    const lastMeta = metaById.get(kids[kids.length - 1].person.id)!
    const firstCenter = childOrigins[0] + firstMeta.nodeX + CARD_W / 2
    const lastCenter =
      childOrigins[childOrigins.length - 1] + lastMeta.nodeX + CARD_W / 2
    const nodeX = (firstCenter + lastCenter) / 2 - CARD_W / 2
    // Depth 0 is the node's own card; children occupy depths 1+.
    const extent: Extent = [{ l: nodeX, r: nodeX + CARD_W }]
    for (const e of merged!) extent.push({ l: e.l, r: e.r })
    const meta: SubtreeMeta = { nodeX, childOrigins, extent }
    metaById.set(node.person.id, meta)
    return extent
  }

  function place(node: OrgNode, originX: number, depth: number): void {
    const meta = metaById.get(node.person.id)!
    positions.set(node.person.id, {
      x: originX + meta.nodeX,
      y: depth * rankH,
    })
    const kids = visibleChildren(node)
    for (let i = 0; i < kids.length; i++) {
      edges.push({ from: node.person.id, to: kids[i].person.id })
      place(kids[i], originX + meta.childOrigins[i], depth + 1)
    }
  }

  let cursor = 0
  let maxDepthPx = 0
  for (const root of roots) {
    const extent = measure(root)
    let minL = Infinity
    let maxR = -Infinity
    for (const e of extent) {
      minL = Math.min(minL, e.l)
      maxR = Math.max(maxR, e.r)
    }
    place(root, cursor - minL, 0)
    cursor += maxR - minL + TREE_GAP
    maxDepthPx = Math.max(maxDepthPx, extent.length * rankH - RANK_GAP)
  }

  return {
    positions,
    edges,
    width: roots.length > 0 ? cursor - TREE_GAP : 0,
    height: maxDepthPx,
  }
}

/** Ancestor chain (inclusive) from a person up to their root. */
export function chainToRoot(
  id: string,
  parentById: Map<string, string | null>
): Set<string> {
  const chain = new Set<string>()
  let cur: string | null = id
  while (cur !== null && !chain.has(cur)) {
    chain.add(cur)
    cur = parentById.get(cur) ?? null
  }
  return chain
}

/** IDs of every ancestor (exclusive) of a person. */
export function ancestorsOf(
  id: string,
  parentById: Map<string, string | null>
): string[] {
  const out: string[] = []
  const seen = new Set<string>([id])
  let cur = parentById.get(id) ?? null
  while (cur !== null && !seen.has(cur)) {
    out.push(cur)
    seen.add(cur)
    cur = parentById.get(cur) ?? null
  }
  return out
}
