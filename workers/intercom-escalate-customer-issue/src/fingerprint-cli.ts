import { readFile } from "node:fs/promises"
import { canonicalPacket, packetFingerprint, parsePacket } from "./canonical.js"

async function main(): Promise<void> {
  const path = process.argv[2]
  if (!path) {
    console.error(
      "Usage: npm run fingerprint -- path/to/escalation-packet.json"
    )
    process.exitCode = 1
    return
  }
  try {
    const raw = await readFile(path, "utf8")
    const packet = parsePacket(JSON.parse(raw))
    process.stdout.write(
      `${canonicalPacket(packet)}\n${packetFingerprint(packet)}\n`
    )
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Invalid escalation packet."
    )
    process.exitCode = 1
  }
}

void main()
