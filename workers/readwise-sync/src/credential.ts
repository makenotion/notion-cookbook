import { createHash } from "node:crypto"

const CREDENTIAL_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/

export function credentialFingerprintForToken(token: string): string {
  const normalized = token.trim()
  if (!normalized) throw new Error("READWISE_ACCESS_TOKEN is not set.")
  return createHash("sha256")
    .update("notion-readwise-worker\0")
    .update(normalized)
    .digest("hex")
}

export function isCredentialFingerprint(value: unknown): value is string {
  return typeof value === "string" && CREDENTIAL_FINGERPRINT_PATTERN.test(value)
}
