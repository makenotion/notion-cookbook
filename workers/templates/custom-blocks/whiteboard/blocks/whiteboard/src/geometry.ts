import type { Point } from "./model"

/** Build a smooth SVG path from a polyline using midpoint quadratic curves. */
export function smoothPath(points: Point[]): string {
  if (points.length === 0) return ""
  if (points.length === 1) {
    const [x, y] = points[0]
    // Dot: tiny segment so round caps render a point.
    return `M ${x} ${y} L ${x + 0.01} ${y}`
  }
  if (points.length === 2) {
    return `M ${points[0][0]} ${points[0][1]} L ${points[1][0]} ${points[1][1]}`
  }
  let d = `M ${points[0][0]} ${points[0][1]}`
  for (let i = 1; i < points.length - 1; i++) {
    const [cx, cy] = points[i]
    const mx = (cx + points[i + 1][0]) / 2
    const my = (cy + points[i + 1][1]) / 2
    d += ` Q ${round2(cx)} ${round2(cy)} ${round2(mx)} ${round2(my)}`
  }
  const last = points[points.length - 1]
  d += ` L ${round2(last[0])} ${round2(last[1])}`
  return d
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Drop points closer than `minDist` to the previous kept point. */
export function samplePolyline(points: Point[], minDist = 2.5): Point[] {
  if (points.length <= 2) return points
  const out: Point[] = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1]
    const dx = points[i][0] - prev[0]
    const dy = points[i][1] - prev[1]
    if (dx * dx + dy * dy >= minDist * minDist) out.push(points[i])
  }
  out.push(points[points.length - 1])
  return out
}

export function boundingBox(points: Point[]): {
  x: number
  y: number
  width: number
  height: number
} {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of points) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** Distance from point p to segment ab. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const abx = b[0] - a[0]
  const aby = b[1] - a[1]
  const apx = p[0] - a[0]
  const apy = p[1] - a[1]
  const lenSq = abx * abx + aby * aby
  let t = lenSq === 0 ? 0 : (apx * abx + apy * aby) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = a[0] + t * abx
  const cy = a[1] + t * aby
  return Math.hypot(p[0] - cx, p[1] - cy)
}

/** Does a circle at `center` with `radius` touch the polyline (absolute points)? */
export function circleHitsPolyline(
  center: Point,
  radius: number,
  points: Point[]
): boolean {
  if (points.length === 0) return false
  if (points.length === 1) {
    return (
      Math.hypot(center[0] - points[0][0], center[1] - points[0][1]) <= radius
    )
  }
  for (let i = 0; i < points.length - 1; i++) {
    if (distToSegment(center, points[i], points[i + 1]) <= radius) return true
  }
  return false
}

/** Snap the vector (dx, dy) to the nearest 45° direction, keeping magnitude. */
export function snapTo45(dx: number, dy: number): Point {
  const len = Math.hypot(dx, dy)
  if (len === 0) return [0, 0]
  const angle = Math.atan2(dy, dx)
  const snapped = (Math.round(angle / (Math.PI / 4)) * Math.PI) / 4
  return [len * Math.cos(snapped), len * Math.sin(snapped)]
}

/** Stable per-id rotation between -1.5° and 1.5°, derived from a string hash. */
export function stickyRotation(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0
  }
  const unit = ((hash % 1000) + 1000) % 1000 // 0..999
  return (unit / 999) * 3 - 1.5
}

/** Arrowhead: two flank points of a triangle at `tip`, pointing away from `from`. */
export function arrowHead(
  from: Point,
  tip: Point,
  size: number
): [Point, Point] {
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0])
  const spread = Math.PI / 7
  return [
    [
      tip[0] - size * Math.cos(angle - spread),
      tip[1] - size * Math.sin(angle - spread),
    ],
    [
      tip[0] - size * Math.cos(angle + spread),
      tip[1] - size * Math.sin(angle + spread),
    ],
  ]
}
