// Shared display and conversion helpers for Stripe resource transforms.

import type { StripeAddress } from "./stripe.js"

// Stripe amounts are integers in the currency's smallest unit. Most currencies
// (including USD) use 2 decimal places, so dividing by 100 recovers the major
// unit. A minority of currencies have no minor unit at all — for those, the
// integer amount Stripe returns already *is* the major unit and must not be
// divided. See https://docs.stripe.com/currencies#zero-decimal.
const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
])

/** Convert a Stripe integer amount into a decimal major-unit number. */
export function amountToDecimal(
  amount: number | null | undefined,
  currency: string | null | undefined
): number | null {
  if (amount == null || !Number.isFinite(amount)) return null

  const normalizedCurrency = currency?.trim().toLowerCase()
  if (normalizedCurrency && ZERO_DECIMAL_CURRENCIES.has(normalizedCurrency)) {
    return amount
  }
  return amount / 100
}

/** Stripe timestamps are Unix seconds; Notion date properties expect ISO 8601. */
export function unixToISO(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null
  return new Date(seconds * 1_000).toISOString()
}

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "")
}

const STATUS_LABELS: Record<string, string> = {
  incomplete: "Incomplete",
  incompleteexpired: "Incomplete Expired",
  trialing: "Trialing",
  active: "Active",
  pastdue: "Past Due",
  canceled: "Canceled",
  unpaid: "Unpaid",
  paused: "Paused",
  succeeded: "Succeeded",
  pending: "Pending",
  failed: "Failed",
}

/** Turn a Stripe API enum value into a readable, title-cased label. */
export function formatEnumLabel(value: string): string {
  const key = normalizedKey(value)
  if (STATUS_LABELS[key]) return STATUS_LABELS[key]

  const spaced = value.trim().replace(/[_-]+/g, " ")
  return spaced.replace(/\b\w/g, (character) => character.toUpperCase())
}

/** Render a Stripe address as a single readable line for a rich-text property. */
export function formatAddress(
  address: StripeAddress | null | undefined
): string | null {
  if (!address) return null

  const parts = [
    address.line1,
    address.line2,
    address.city,
    address.state,
    address.postal_code,
    address.country,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))

  return parts.length > 0 ? parts.join(", ") : null
}

export function dashboardUrl(path: string): string {
  return `https://dashboard.stripe.com/${path}`
}
