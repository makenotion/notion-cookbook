// ──────────────────────────────────────────────────────────────────────
// Customization surface — start here
// ──────────────────────────────────────────────────────────────────────
//
// This is the main file you (or your AI coding agent, via /setup) edit to
// make the template yours. Code beyond src/sources/ and src/schema.ts
// rarely needs touching.

export type DocketConfig = {
  // Applied to a docket number; the first capture group is the family id
  // used to group offices (US + EP + …) into one family. Example for
  // "ACME.1234.US01":  /\.(\d+)\./
  familyRegex: RegExp
}

function configuredApplicants(value: string | undefined): string[] {
  if (value === undefined) return ["ACME Corporation"]
  const trimmed = value.trim()
  let entries: string[]
  if (trimmed.startsWith("[")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      const detail = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, 200)
      throw new Error(`PORTFOLIO_APPLICANTS is not valid JSON: ${detail}`)
    }
    if (
      !Array.isArray(parsed) ||
      !parsed.every((entry) => typeof entry === "string")
    )
      throw new Error(
        "PORTFOLIO_APPLICANTS JSON value must be an array of strings"
      )
    entries = parsed
  } else {
    // Backwards compatibility for existing deployments. JSON arrays are
    // preferred because a comma can be part of a legal applicant name.
    entries = value.split(",")
  }
  const applicants = new Map<string, string>()
  for (const entry of entries) {
    const normalized = entry.trim().replace(/\s+/g, " ")
    if (!normalized) continue
    const key = normalized.toLocaleLowerCase("en-US")
    if (!applicants.has(key)) applicants.set(key, normalized)
  }
  return [...applicants.values()]
}

export const config = {
  // The Notion database title created on first deploy.
  notionDatabaseTitle: "Patent Portfolio",

  // CUSTOMIZE: your applicant name(s) exactly as registered with patent
  // offices — this drives USPTO and EPO discovery. Override locally for
  // testing with PORTFOLIO_APPLICANTS=["Acme, Inc.","Acme LLC"] in
  // .env. Legacy comma-separated values remain supported for names that
  // do not themselves contain commas.
  // The deploy runtime injects per-run environment values after evaluating
  // modules, so this must be a getter rather than a module-scope snapshot.
  get applicants(): string[] {
    return configuredApplicants(process.env.PORTFOLIO_APPLICANTS)
  },

  // Toggle sources. USPTO and EPO each work out of the box and are fully
  // independent — enable AT LEAST ONE (both is fine). Turn off the office
  // you don't have keys for yet: e.g. set epo: false to deploy on US data
  // alone, and add Europe later by flipping it back on. docketing + spend
  // are example stubs you implement against your own systems (see
  // src/sources/*.example.ts) — leave false until then.
  sources: {
    uspto: true,
    epo: true,
    docketing: false,
    spend: false,
  },

  // CUSTOMIZE only if docketing is enabled: how to derive a family id from
  // your docket numbers. null = no family grouping.
  docket: null as DocketConfig | null,
}
