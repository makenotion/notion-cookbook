import { readFile } from "node:fs/promises"

import { canonicalPacket, sha256, validateInput } from "./policy.js"
import type { PublishPreparedReleaseInput } from "./types.js"

async function main(): Promise<void> {
  const path = process.argv[2]
  if (!path) {
    throw new Error("Usage: npm run fingerprint -- path/to/packet.json")
  }

  const input = JSON.parse(
    await readFile(path, "utf8")
  ) as PublishPreparedReleaseInput
  input.approvalFingerprint = sha256(canonicalPacket(input))
  validateInput(input)
  process.stdout.write(`${input.approvalFingerprint}\n`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Fingerprint failed"
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
