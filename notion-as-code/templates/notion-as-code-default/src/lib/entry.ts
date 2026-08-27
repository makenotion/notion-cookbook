// Build entry: executes the user script (src/main.ts), then writes the
// recorded intents to dist/intents.json for `ntn notion-as-code apply`.
import { mkdirSync, writeFileSync } from "node:fs"
import "../main"
import { getIntents } from "./notion"

mkdirSync("dist", { recursive: true })
writeFileSync("dist/intents.json", JSON.stringify(getIntents(), null, 2))
