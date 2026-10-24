// Shared formatting helpers used by the Zendesk resource transforms.

// Converts API values such as "mobile_sdk" to display labels such as
// "Mobile Sdk". Resource-specific maps handle special casing such as "API".
export function formatLabel(s: string): string {
  if (!s) return s
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

export function dateOnly(value: string): string {
  if (!value) return ""
  if (value.includes("T")) return value.slice(0, 10)
  return value.slice(0, 10)
}
