export type PageRequest = {
  page: number
  asOfEntryDateTime: string
  asOfEffectiveDate: string
}

export function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return value as number
}

export function isoDateTime(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    throw new Error(`${label} must be an ISO 8601 timestamp.`)
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be an ISO 8601 timestamp.`)
  }
  return value
}

export function isoDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be an ISO 8601 date.`)
  }

  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${label} must be an ISO 8601 date.`)
  }
  return value
}

export function normalizedWorkEmail(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a valid email address.`)
  }

  const normalized = value.trim().toLowerCase()
  if (
    normalized.length === 0 ||
    // Notion rejects email property values above 200 characters.
    normalized.length > 200 ||
    /[\u0000-\u0020\u007f]/u.test(normalized) ||
    !/^[^@]+@[^@]+$/u.test(normalized)
  ) {
    throw new Error(`${label} must be a valid email address.`)
  }
  return normalized
}

export function validatePageRequest(request: PageRequest): void {
  positiveInteger(request.page, "Workday page")
  isoDate(request.asOfEffectiveDate, "Workday effective date")
  isoDateTime(request.asOfEntryDateTime, "Workday entry timestamp")
}
