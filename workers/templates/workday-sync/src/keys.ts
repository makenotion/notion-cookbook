import { createHash } from "node:crypto"

export type DirectoryKeyKind = "person" | "organization"

/**
 * Workday WIDs are stable integration identifiers, but they are not useful to
 * an employee browsing the directory. Hash them before they cross the Notion
 * sync boundary, while keeping a deterministic key for upserts and relations.
 */
export function directoryKey(kind: DirectoryKeyKind, workdayWid: string) {
  const wid = workdayWid.trim()
  if (!wid) throw new Error(`Workday ${kind} WID is empty.`)

  const digest = createHash("sha256")
    .update(`notion-workday-directory:${kind}:${wid}`, "utf8")
    .digest("hex")

  return `wd-${kind}-${digest.slice(0, 32)}`
}
