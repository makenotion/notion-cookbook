// Shared helpers used across resource transforms.

export function dateOnly(value: string): string {
  if (!value) return ""
  if (value.includes("T")) return value.slice(0, 10)
  return value.slice(0, 10)
}
