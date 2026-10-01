// ──────────────────────────────────────────────────────────────────────
// Change detection
// ──────────────────────────────────────────────────────────────────────
//
// The delta emits a row only when its fingerprint changes — a hash of
// everything the row is built from. Bump DERIVATION_VERSION whenever a
// property DERIVATION rule changes but its raw inputs don't (e.g. you
// change how Est. Expiry is computed): without it the delta can't tell the
// output should change and won't re-emit. Bumping forces a one-time full
// re-emit on the next cycle.

import { createHash } from "node:crypto"

export const DERIVATION_VERSION = "2026-08-17a"

export function fingerprint(basis: unknown): string {
  const json =
    typeof basis === "string"
      ? basis
      : JSON.stringify(basis, replacerSorted(basis))
  return createHash("sha256")
    .update(`${DERIVATION_VERSION}\0${json}`)
    .digest("hex")
    .slice(0, 16)
}

// Stable key ordering so semantically-equal objects hash identically.
function replacerSorted(_root: unknown) {
  return (key: string, value: unknown) => {
    // Continuity parents are a mathematical set. USPTO does not guarantee
    // their response order, so canonicalize them before hashing; otherwise
    // an order-only response change re-emits an unchanged application.
    if (
      key === "parents" &&
      Array.isArray(value) &&
      value.every((item) => typeof item === "string")
    ) {
      return [...new Set(value as string[])].sort()
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : 1
        )
      )
    }
    return value
  }
}
