export type IconColor =
  | "gray"
  | "lightgray"
  | "brown"
  | "yellow"
  | "orange"
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "red"

/** Canonical name returned by the host, paired with a supported SVG color. */
export type IconSelection = { name: string; color: IconColor }

export const colors: { value: IconColor; label: string; token: string }[] = [
  { value: "gray", label: "Gray", token: "--gray-80" },
  { value: "lightgray", label: "Light gray", token: "--gray-40" },
  { value: "brown", label: "Brown", token: "--brown-80" },
  { value: "yellow", label: "Yellow", token: "--yellow-80" },
  { value: "orange", label: "Orange", token: "--orange-80" },
  { value: "green", label: "Green", token: "--green-80" },
  { value: "blue", label: "Blue", token: "--blue-80" },
  { value: "purple", label: "Purple", token: "--purple-80" },
  { value: "pink", label: "Pink", token: "--pink-80" },
  { value: "red", label: "Red", token: "--red-80" },
]

/** Native button grid navigation, clamped at the first and last available item. */
export function nextGridIndex(
  key: string,
  index: number,
  count: number
): number | undefined {
  if (count === 0) return undefined
  switch (key) {
    case "ArrowRight":
      return Math.min(index + 1, count - 1)
    case "ArrowLeft":
      return Math.max(index - 1, 0)
    case "ArrowDown":
      return Math.min(index + 8, count - 1)
    case "ArrowUp":
      return Math.max(index - 8, 0)
    case "Home":
      return 0
    case "End":
      return count - 1
    default:
      return undefined
  }
}
