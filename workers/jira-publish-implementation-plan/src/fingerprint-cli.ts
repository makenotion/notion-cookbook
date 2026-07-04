import { readFile } from "node:fs/promises"

import { canonicalPlan, sha256 } from "./policy.js"
import type { PublishImplementationPlanInput } from "./types.js"

const path = process.argv[2]
if (!path) {
  throw new Error("Usage: npm run fingerprint -- path/to/plan.json")
}

const decoded = JSON.parse(await readFile(path, "utf8")) as Omit<
  PublishImplementationPlanInput,
  "planHash"
>
const input = { ...decoded, planHash: "0".repeat(64) }
process.stdout.write(`${sha256(canonicalPlan(input))}\n`)
