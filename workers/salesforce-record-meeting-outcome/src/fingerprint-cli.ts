import { readFile } from "node:fs/promises"

import { inputFingerprint, validateCanonicalInput } from "./policy.js"
import type { RecordMeetingOutcomeInput } from "./types.js"

async function main(): Promise<void> {
  const inputPath = process.argv[2]
  if (!inputPath) {
    throw new Error(
      "Usage: npm run fingerprint -- /path/to/approved-input.json"
    )
  }

  const parsed: unknown = JSON.parse(await readFile(inputPath, "utf8"))
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The approved input file must contain one JSON object.")
  }

  // approvalFingerprint is excluded from the canonical hash by design. This
  // placeholder lets an operator hash the packet before the approval property
  // is populated, while all semantic fields are still parsed canonically.
  const input = {
    ...(parsed as Record<string, unknown>),
    approvalFingerprint: "0".repeat(64),
  } as RecordMeetingOutcomeInput
  validateCanonicalInput(input)
  process.stdout.write(`${inputFingerprint(input)}\n`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Fingerprint failed."
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
