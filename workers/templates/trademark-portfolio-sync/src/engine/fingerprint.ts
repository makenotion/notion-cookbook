// ──────────────────────────────────────────────────────────────────────
// Change detection
// ──────────────────────────────────────────────────────────────────────
//
// The delta emits a row only when its fingerprint changes — a hash of
// everything the row is built from. Bump DERIVATION_VERSION whenever a
// property DERIVATION rule changes but its raw inputs don't (e.g. you
// change how Next Deadline is computed): without it the delta can't tell
// the output should change and won't re-emit. Bumping forces a one-time
// full re-emit on the next cycle.

import { createHash } from "node:crypto"

export const DERIVATION_VERSION = "2026-08-18a"

export function fingerprint(basis: unknown): string {
  const json =
    typeof basis === "string"
      ? basis
      : JSON.stringify(basis, replacerSorted(basis))
  return createHash("sha256")
    .update(`${DERIVATION_VERSION} ${json}`)
    .digest("hex")
    .slice(0, 16)
}

// Stable key ordering so semantically-equal objects hash identically.
function replacerSorted(_root: unknown) {
  return (_key: string, value: unknown) => {
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
