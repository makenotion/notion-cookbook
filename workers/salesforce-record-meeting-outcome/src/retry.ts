export const MAX_RETRY_AFTER_SECONDS = 3_600

function headerValue(headers: unknown, name: string): string | null {
  if (headers == null || typeof headers !== "object") return null

  const get = (headers as { get?: unknown }).get
  if (typeof get === "function") {
    const value = get.call(headers, name)
    return typeof value === "string" ? value : null
  }

  const entry = Object.entries(headers as Record<string, unknown>).find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  )
  const value = entry?.[1]
  if (typeof value === "string") return value
  if (Array.isArray(value) && typeof value[0] === "string") return value[0]
  return null
}

export function boundedRetryAfterSeconds(
  headers: unknown,
  nowMs: number = Date.now()
): number | null {
  const value = headerValue(headers, "Retry-After")
  if (!value) return null

  const normalized = value.trim()
  if (/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) {
    const seconds = Number(normalized)
    if (!Number.isFinite(seconds) || seconds < 0) return null
    return Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(seconds))
  }

  const at = Date.parse(normalized)
  if (Number.isNaN(at)) return null
  return Math.min(
    MAX_RETRY_AFTER_SECONDS,
    Math.max(0, Math.ceil((at - nowMs) / 1_000))
  )
}
