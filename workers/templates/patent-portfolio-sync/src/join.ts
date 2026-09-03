// ──────────────────────────────────────────────────────────────────────
// The join: assemble portfolio rows from all enabled sources
// ──────────────────────────────────────────────────────────────────────

import { config } from "./config.js"
import {
  type SourceHealth,
  type SourceSnapshots,
  SourceRunner,
  type SyncMode,
} from "./engine/resilience.js"
import {
  applicationIdentity,
  buildAppProperties,
  buildFamilyProperties,
  type Enrichment,
  type FamilyAggregate,
  normalizeApplicationNumber,
  recordKey,
} from "./schema.js"
import { docketingAdapter } from "./sources/docketing.example.js"
import { spendAdapter } from "./sources/spend.example.js"
import { fetchEpoRecords } from "./sources/epo.js"
import type {
  DocketInfo,
  DocketLookup,
  PatentRecord,
  SpendInfo,
} from "./sources/types.js"
import { fetchUsptoRecords } from "./sources/uspto.js"

export type PortfolioRow = {
  key: string
  properties: Record<string, unknown>
  fingerprintBasis: unknown // hashed for change detection; excludes Last Sync
}

const CONTINUITY_PREFIX = "CONTINUITY:"
const DOCKET_PREFIX = "DOCKET:"
const FAMILY_ROW_PREFIX = "FAMILY:"

const familyRowKey = (familyIdentity: string): string =>
  `${FAMILY_ROW_PREFIX}${familyIdentity}`

const identityFor = (
  jurisdiction: PatentRecord["jurisdiction"],
  applicationNumber: string
): string =>
  `${jurisdiction}:${normalizeApplicationNumber(applicationNumber, jurisdiction)}`

const US_RECORD_TYPES = new Set([
  "Original",
  "Continuation",
  "Continuation-in-Part",
  "Divisional",
  "National Stage Entry",
  "PCT",
  "Reissue",
  "Reexamination",
  "Supplemental Examination",
  "Design",
  "Plant",
  "Provisional",
  "Substitute",
])
const EP_RECORD_TYPES = new Set(["Original", "Divisional", "Regional Phase"])

function validRecordDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ]
  return (
    year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
  )
}

function recordNullableString(
  value: unknown,
  field: string,
  identity: string
): string | null {
  if (value === null) return null
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(
      `[join] ${identity} has malformed ${field}; expected a non-empty string or null`
    )
  return value.trim()
}

function recordDate(
  value: unknown,
  field: string,
  identity: string
): string | null {
  if (value === null) return null
  if (typeof value !== "string" || !validRecordDate(value))
    throw new Error(
      `[join] ${identity} has malformed ${field}; expected YYYY-MM-DD or null`
    )
  return value
}

function validApplicationNumber(
  value: string,
  jurisdiction: PatentRecord["jurisdiction"]
): boolean {
  if (jurisdiction === "EP") return /^\d{8}$/.test(value)
  if (/^\d{8}$/.test(value)) return true
  const pct = /^PCT[A-Z]{2}(\d{4})(\d{6})$/.exec(value)
  return Boolean(pct && Number(pct[1]) >= 1978 && Number(pct[2]) > 0)
}

function officeRecords(
  value: unknown,
  snapshotKey: "uspto" | "epo",
  source: PatentRecord["source"],
  jurisdiction: PatentRecord["jurisdiction"]
): PatentRecord[] {
  if (!Array.isArray(value))
    throw new Error(`[join] ${snapshotKey} source data must be an array`)
  for (const record of value) {
    if (
      !isPlainObject(record) ||
      record.source !== source ||
      record.jurisdiction !== jurisdiction
    )
      throw new Error(
        `[join] ${snapshotKey} snapshot contains a record from the wrong source or jurisdiction`
      )
  }
  // Validate and canonicalize every field while still inside SourceRunner's
  // callback. Otherwise a semantically malformed fresh response could be
  // recorded as last-known-good before the later portfolio assembly rejects
  // it, poisoning the fallback snapshot for the next resilient cycle.
  return value.map((record) => normalizeRecord(record as PatentRecord))
}

function normalizeRecord(rec: PatentRecord): PatentRecord {
  if (!isPlainObject(rec))
    throw new Error("[join] patent-office record must be an object")
  if (rec.source !== "USPTO" && rec.source !== "EPO")
    throw new Error(`[join] patent-office record has invalid source`)
  if (rec.jurisdiction !== "US" && rec.jurisdiction !== "EP")
    throw new Error(`[join] patent-office record has invalid jurisdiction`)
  if (
    (rec.source === "USPTO" && rec.jurisdiction !== "US") ||
    (rec.source === "EPO" && rec.jurisdiction !== "EP")
  )
    throw new Error(
      `[join] ${rec.source} record has mismatched jurisdiction ${rec.jurisdiction}`
    )
  if (typeof rec.applicationNumber !== "string")
    throw new Error(`[join] ${rec.source} record has invalid applicationNumber`)
  const applicationNumber = normalizeApplicationNumber(
    rec.applicationNumber,
    rec.jurisdiction
  )
  const identity = `${rec.jurisdiction}:${applicationNumber || "(empty)"}`
  if (!validApplicationNumber(applicationNumber, rec.jurisdiction)) {
    throw new Error(
      `[join] ${identity} has an invalid application number after normalization`
    )
  }
  if (typeof rec.title !== "string" || !rec.title.trim())
    throw new Error(`[join] ${identity} has a missing or empty title`)
  const allowedTypes =
    rec.jurisdiction === "US" ? US_RECORD_TYPES : EP_RECORD_TYPES
  if (
    rec.type !== null &&
    (typeof rec.type !== "string" || !allowedTypes.has(rec.type))
  )
    throw new Error(
      `[join] ${identity} has unsupported type ${String(rec.type)}`
    )
  if (
    !Array.isArray(rec.parents) ||
    rec.parents.some((p) => typeof p !== "string")
  )
    throw new Error(`[join] ${identity} parents must be an array of strings`)
  const parents = Array.from(
    new Set(
      rec.parents.map((parent) => {
        const normalized = normalizeApplicationNumber(parent, rec.jurisdiction)
        if (!validApplicationNumber(normalized, rec.jurisdiction))
          throw new Error(
            `[join] ${identity} has invalid parent application number ${JSON.stringify(parent)}`
          )
        if (normalized === applicationNumber)
          throw new Error(`[join] ${identity} cannot be its own parent`)
        return normalized
      })
    )
  ).sort()
  const filingDate = recordDate(rec.filingDate, "filingDate", identity)
  const grantDate = recordDate(rec.grantDate, "grantDate", identity)
  const estExpiry = recordDate(rec.estExpiry, "estExpiry", identity)
  if (estExpiry && !grantDate)
    throw new Error(
      `[join] ${identity} has an estimated expiry without a grant date`
    )
  return {
    source: rec.source,
    jurisdiction: rec.jurisdiction,
    applicationNumber,
    title: rec.title.trim(),
    type: rec.type,
    filingDate,
    status: recordNullableString(rec.status, "status", identity),
    statusDate: recordDate(rec.statusDate, "statusDate", identity),
    grantDate,
    patentNumber: recordNullableString(
      rec.patentNumber,
      "patentNumber",
      identity
    ),
    publicationNumber: recordNullableString(
      rec.publicationNumber,
      "publicationNumber",
      identity
    ),
    estExpiry,
    parents,
  }
}

const completeness = (rec: PatentRecord): number =>
  [
    rec.title,
    rec.type,
    rec.filingDate,
    rec.status,
    rec.statusDate,
    rec.grantDate,
    rec.patentNumber,
    rec.publicationNumber,
    rec.estExpiry,
  ].filter((v) => v != null && v !== "").length

function preferredRecord(a: PatentRecord, b: PatentRecord): PatentRecord {
  const score = completeness(b) - completeness(a)
  if (score !== 0) return score < 0 ? a : b
  const statusDate = (b.statusDate ?? "").localeCompare(a.statusDate ?? "")
  if (statusDate !== 0) return statusDate < 0 ? a : b
  return JSON.stringify(a) <= JSON.stringify(b) ? a : b
}

// Applicant aliases can return the same office record more than once. Collapse
// on the same canonical identity before family counts, docket lookup, row
// emission, or fingerprints see it. A deterministic preferred record makes a
// rare inconsistent duplicate stable across applicant ordering.
function canonicalizeRecords(records: PatentRecord[]): PatentRecord[] {
  const byIdentity = new Map<string, PatentRecord>()
  for (const raw of records) {
    const rec = normalizeRecord(raw)
    const identity = applicationIdentity(rec)
    const previous = byIdentity.get(identity)
    if (!previous) {
      byIdentity.set(identity, rec)
      continue
    }
    const preferred = preferredRecord(previous, rec)
    byIdentity.set(identity, {
      ...preferred,
      parents: Array.from(
        new Set([...previous.parents, ...rec.parents])
      ).sort(),
    })
  }
  return [...byIdentity.values()].sort((a, b) =>
    recordKey(a).localeCompare(recordKey(b))
  )
}

type ContinuityPlan = {
  components: Map<string, string[]>
}

const compareFamilyMembers = (a: PatentRecord, b: PatentRecord): number => {
  const aDate = a.filingDate ?? "9999-12-31"
  const bDate = b.filingDate ?? "9999-12-31"
  if (aDate !== bDate) return aDate.localeCompare(bDate)
  return recordKey(a).localeCompare(recordKey(b))
}

// Same-office continuity only. Every union-find key includes jurisdiction,
// and both application and parent numbers are normalized first, so a US and
// EP number can never collide and punctuation variants still join.
function deriveContinuityFamilies(records: PatentRecord[]): ContinuityPlan {
  const present = new Map(records.map((r) => [applicationIdentity(r), r]))
  const parent = new Map([...present.keys()].map((key) => [key, key]))

  const find = (x: string): string => {
    const p = parent.get(x)
    if (!p || p === x) return x
    const root = find(p)
    parent.set(x, root)
    return root
  }
  const union = (a: string, b: string) => {
    const aRoot = find(a)
    const bRoot = find(b)
    if (aRoot === bRoot) return
    // Root choice does not define the family ID, but keeping it deterministic
    // makes debugging and reconstruction from snapshots easier.
    if (aRoot < bRoot) parent.set(bRoot, aRoot)
    else parent.set(aRoot, bRoot)
  }

  for (const rec of records) {
    const identity = applicationIdentity(rec)
    for (const rawParent of rec.parents) {
      const parentIdentity = identityFor(rec.jurisdiction, rawParent)
      // Keep an absent parent as a phantom union-find node. It is never
      // emitted, but it still joins discovered siblings that name the same
      // parent (the parent may no longer match the applicant query).
      union(identity, parentIdentity)
    }
  }

  const membersByRoot = new Map<string, PatentRecord[]>()
  for (const rec of records) {
    const root = find(applicationIdentity(rec))
    const members = membersByRoot.get(root) ?? []
    members.push(rec)
    membersByRoot.set(root, members)
  }

  const components = new Map<string, string[]>()
  for (const members of membersByRoot.values()) {
    members.sort(compareFamilyMembers)
    const familyIdentity = `${CONTINUITY_PREFIX}${applicationIdentity(members[0]!)}`
    const identities = members.map(applicationIdentity).sort()
    components.set(familyIdentity, identities)
  }
  return { components }
}

type DocketIndex = {
  composite: Map<string, DocketInfo>
  legacy: Map<string, DocketInfo>
  identitiesByBareNumber: Map<string, Set<string>>
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const sameDocket = (a: DocketInfo, b: DocketInfo): boolean =>
  a.docketNumber === b.docketNumber && a.familyId === b.familyId

function normalizedDocket(info: unknown, sourceKey: string): DocketInfo {
  if (!isPlainObject(info)) {
    throw new Error(
      `[join] docket key "${sourceKey}" must map to a DocketInfo object`
    )
  }
  if (typeof info.docketNumber !== "string" || !info.docketNumber.trim()) {
    throw new Error(
      `[join] docket key "${sourceKey}" has a missing or empty docketNumber`
    )
  }
  if (info.familyId !== null && typeof info.familyId !== "string") {
    throw new Error(
      `[join] docket key "${sourceKey}" familyId must be a non-empty string or null`
    )
  }
  const familyId = info.familyId === null ? null : info.familyId.trim()
  if (familyId === "") {
    throw new Error(`[join] docket key "${sourceKey}" has an empty familyId`)
  }
  return { docketNumber: info.docketNumber.trim(), familyId }
}

// Adapters are runtime trust boundaries despite their TypeScript interfaces.
// Project every accepted key to one requested jurisdiction-qualified identity
// before SourceRunner records it as last-known-good. This also makes a legacy
// bare key safe only when it resolves to exactly one requested application.
function projectDocketLookup(
  value: unknown,
  records: PatentRecord[],
  opts: { dropUnrequested?: boolean } = {}
): DocketLookup {
  if (!isPlainObject(value))
    throw new Error("[join] docketing adapter must return an object")

  const requestedIdentities = new Set<string>()
  const identitiesByBareNumber = new Map<string, Set<string>>()
  for (const rec of records) {
    const identity = applicationIdentity(rec)
    const bare = normalizeApplicationNumber(
      rec.applicationNumber,
      rec.jurisdiction
    )
    requestedIdentities.add(identity)
    const identities = identitiesByBareNumber.get(bare) ?? new Set<string>()
    identities.add(identity)
    identitiesByBareNumber.set(bare, identities)
  }

  const projected = new Map<string, DocketInfo>()
  const sourceByIdentity = new Map<string, string>()
  for (const [sourceKey, rawInfo] of Object.entries(value)) {
    const trimmedKey = sourceKey.trim()
    if (!trimmedKey)
      throw new Error("[join] docketing adapter returned an empty key")
    // Validate cached values even when their once-current application has
    // disappeared and the entry will be dropped below.
    const info = normalizedDocket(rawInfo, sourceKey)

    const qualified = /^(US|EP)\s*[:-]\s*(.*)$/i.exec(trimmedKey)
    const unsupported = /^([A-Z]{2})\s*[:-]/i.exec(trimmedKey)
    let identity: string
    if (qualified) {
      const jurisdiction =
        qualified[1]!.toUpperCase() as PatentRecord["jurisdiction"]
      const bare = normalizeApplicationNumber(qualified[2]!, jurisdiction)
      if (!bare)
        throw new Error(
          `[join] docket key "${sourceKey}" has an empty application number`
        )
      identity = `${jurisdiction}:${bare}`
      if (!requestedIdentities.has(identity)) {
        if (opts.dropUnrequested) continue
        throw new Error(
          `[join] docket key "${sourceKey}" does not identify a requested application`
        )
      }
    } else {
      if (unsupported)
        throw new Error(
          `[join] docket key "${sourceKey}" uses unsupported jurisdiction ${unsupported[1]!.toUpperCase()}`
        )
      const bare = normalizeApplicationNumber(trimmedKey)
      if (!bare)
        throw new Error(
          `[join] docket key "${sourceKey}" has an empty application number`
        )
      const matches = identitiesByBareNumber.get(bare)
      if (!matches || matches.size === 0) {
        if (opts.dropUnrequested) continue
        throw new Error(
          `[join] docket key "${sourceKey}" does not identify a requested application`
        )
      }
      if (matches.size !== 1) {
        // A legacy bare LKG key can become ambiguous when a same-number app
        // appears in another jurisdiction. Dropping it is safer than guessing.
        if (opts.dropUnrequested) continue
        throw new Error(
          `[join] legacy docket key "${sourceKey}" is ambiguous across ${matches.size} jurisdiction-qualified applications`
        )
      }
      identity = [...matches][0]!
    }

    const previous = projected.get(identity)
    if (previous && !sameDocket(previous, info)) {
      throw new Error(
        `[join] conflicting docket entries "${sourceByIdentity.get(identity)}" and "${sourceKey}" normalize to ${identity}`
      )
    }
    projected.set(identity, info)
    sourceByIdentity.set(identity, sourceKey)
  }

  return Object.fromEntries(
    [...projected.entries()].sort(([a], [b]) => a.localeCompare(b))
  )
}

function makeDocketIndex(
  lookup: DocketLookup,
  records: PatentRecord[]
): DocketIndex {
  const composite = new Map<string, DocketInfo>()
  const legacy = new Map<string, DocketInfo>()
  const identitiesByBareNumber = new Map<string, Set<string>>()
  for (const rec of records) {
    const bare = normalizeApplicationNumber(
      rec.applicationNumber,
      rec.jurisdiction
    )
    const identities = identitiesByBareNumber.get(bare) ?? new Set<string>()
    identities.add(applicationIdentity(rec))
    identitiesByBareNumber.set(bare, identities)
  }

  for (const [sourceKey, rawInfo] of Object.entries(lookup)) {
    const info = normalizedDocket(rawInfo, sourceKey)
    const qualified = /^(US|EP)[:-](.+)$/i.exec(sourceKey.trim())
    if (qualified) {
      const jurisdiction =
        qualified[1]!.toUpperCase() as PatentRecord["jurisdiction"]
      const identity = identityFor(jurisdiction, qualified[2]!)
      const previous = composite.get(identity)
      if (previous && !sameDocket(previous, info)) {
        throw new Error(
          `[join] conflicting docket entries normalize to ${identity}`
        )
      }
      composite.set(identity, info)
      continue
    }

    const bare = normalizeApplicationNumber(sourceKey)
    const previous = legacy.get(bare)
    if (previous && !sameDocket(previous, info)) {
      throw new Error(
        `[join] conflicting legacy docket entries normalize to ${bare}`
      )
    }
    legacy.set(bare, info)
  }
  return { composite, legacy, identitiesByBareNumber }
}

function docketFor(rec: PatentRecord, index: DocketIndex): DocketInfo | null {
  const identity = applicationIdentity(rec)
  const qualified = index.composite.get(identity)
  if (qualified) return qualified

  const bare = normalizeApplicationNumber(
    rec.applicationNumber,
    rec.jurisdiction
  )
  const legacy = index.legacy.get(bare)
  if (!legacy) return null
  const matches = index.identitiesByBareNumber.get(bare)?.size ?? 0
  if (matches !== 1) {
    throw new Error(
      `[join] legacy docket key "${bare}" is ambiguous across ${matches} jurisdiction-qualified applications; return keys like US:${bare} / EP:${bare}`
    )
  }
  return legacy
}

type FamilyGroup = {
  identity: string
  rowKey: string
  spendKey: string
  members: PatentRecord[]
}

type PreparedPortfolio = {
  records: PatentRecord[]
  enrichByApp: Map<string, Enrichment>
  families: Map<string, FamilyGroup>
  spendKeys: string[]
}

const spendKeyFor = (familyIdentity: string): string =>
  familyIdentity.startsWith(DOCKET_PREFIX)
    ? familyIdentity.slice(DOCKET_PREFIX.length)
    : familyIdentity.slice(CONTINUITY_PREFIX.length)

function projectSpendLookup(
  value: unknown,
  requestedKeys: readonly string[],
  opts: { dropUnrequested?: boolean } = {}
): Record<string, SpendInfo> {
  if (!isPlainObject(value))
    throw new Error("[join] spend adapter must return an object")
  const requested = new Set(requestedKeys)
  const projected = new Map<string, SpendInfo>()
  for (const [key, rawInfo] of Object.entries(value)) {
    if (!key)
      throw new Error("[join] spend adapter returned an empty family key")
    if (!isPlainObject(rawInfo))
      throw new Error(
        `[join] spend key "${key}" must map to a SpendInfo object`
      )
    const amount = (field: "realized" | "pending"): number => {
      const candidate = rawInfo[field]
      if (
        typeof candidate !== "number" ||
        !Number.isFinite(candidate) ||
        candidate < 0
      )
        throw new Error(
          `[join] spend key "${key}" ${field} must be a finite non-negative number`
        )
      return Object.is(candidate, -0) ? 0 : candidate
    }
    // Validate cached values even when their family is stale and dropped.
    const realized = amount("realized")
    const pending = amount("pending")
    if (!requested.has(key)) {
      if (opts.dropUnrequested) continue
      throw new Error(
        `[join] spend adapter returned unrequested family key "${key}"`
      )
    }
    projected.set(key, {
      realized,
      pending,
    })
  }
  return Object.fromEntries(
    [...projected.entries()].sort(([a], [b]) => a.localeCompare(b))
  )
}

function preparePortfolio(
  recordsInput: PatentRecord[],
  docketLookup: DocketLookup
): PreparedPortfolio {
  const records = canonicalizeRecords(recordsInput)
  const continuity = deriveContinuityFamilies(records)
  const docketIndex = makeDocketIndex(docketLookup, records)
  const docketByApp = new Map<string, DocketInfo | null>()
  for (const rec of records)
    docketByApp.set(applicationIdentity(rec), docketFor(rec, docketIndex))

  const familyIdentityByApp = new Map<string, string | null>()
  for (const [publicFamily, identities] of continuity.components) {
    const docketFamilies = new Set<string>()
    for (const identity of identities) {
      const docket = docketByApp.get(identity)
      if (docket?.familyId) docketFamilies.add(docket.familyId)
    }
    if (docketFamilies.size > 1) {
      throw new Error(
        `[join] conflicting docket family IDs (${[...docketFamilies].sort().join(", ")}) in continuity component ${publicFamily}`
      )
    }
    const propagated = [...docketFamilies][0]
    for (const identity of identities) {
      const docket = docketByApp.get(identity)
      familyIdentityByApp.set(
        identity,
        docket?.familyId === null && docket !== null
          ? null
          : propagated
            ? `${DOCKET_PREFIX}${propagated}`
            : publicFamily
      )
    }
  }

  const enrichByApp = new Map<string, Enrichment>()
  const families = new Map<string, FamilyGroup>()
  for (const rec of records) {
    const identity = applicationIdentity(rec)
    const docket = docketByApp.get(identity) ?? null
    const familyIdentity = familyIdentityByApp.get(identity) ?? null
    const rowKey = familyIdentity ? familyRowKey(familyIdentity) : null
    enrichByApp.set(identity, {
      docket,
      familyId: rowKey,
      spend: null,
      docketingEnabled: config.sources.docketing,
      spendEnabled: config.sources.spend,
    })
    if (!familyIdentity || !rowKey) continue
    const group = families.get(familyIdentity) ?? {
      identity: familyIdentity,
      rowKey,
      spendKey: spendKeyFor(familyIdentity),
      members: [],
    }
    group.members.push(rec)
    families.set(familyIdentity, group)
  }
  for (const group of families.values())
    group.members.sort(compareFamilyMembers)

  if (config.sources.spend) {
    const familyBySpendKey = new Map<string, string>()
    for (const family of families.values()) {
      const previousFamily = familyBySpendKey.get(family.spendKey)
      if (previousFamily && previousFamily !== family.identity) {
        throw new Error(
          `[join] family identities "${previousFamily}" and "${family.identity}" collide on spend key "${family.spendKey}"; rename the docket family ID so each family has a unique billing key`
        )
      }
      familyBySpendKey.set(family.spendKey, family.identity)
    }
  }

  return {
    records,
    enrichByApp,
    families,
    spendKeys: Array.from(
      new Set([...families.values()].map((family) => family.spendKey))
    ).sort(),
  }
}

function requireSnapshot<T>(
  snapshots: SourceSnapshots,
  key: string,
  enabled: boolean,
  fallback: T
): T {
  if (!enabled) return fallback
  const snapshot = snapshots[key]
  if (!snapshot) {
    throw new Error(`[join] enabled source "${key}" has no frozen snapshot`)
  }
  return snapshot.data as T
}

function rowsFromPrepared(
  prepared: PreparedPortfolio,
  spendByFamily: Record<string, SpendInfo>,
  nowIso: string
): PortfolioRow[] {
  const lastSync = nowIso.slice(0, 10)
  const rows: PortfolioRow[] = []
  for (const rec of prepared.records) {
    const enrich = prepared.enrichByApp.get(applicationIdentity(rec)) ?? {
      docket: null,
      familyId: null,
      spend: null,
      docketingEnabled: config.sources.docketing,
      spendEnabled: config.sources.spend,
    }
    rows.push({
      key: recordKey(rec),
      properties: buildAppProperties(rec, enrich, lastSync),
      fingerprintBasis: {
        rec,
        docket: enrich.docket,
        familyId: enrich.familyId,
        docketingEnabled: config.sources.docketing,
        spendEnabled: config.sources.spend,
      },
    })
  }

  for (const family of prepared.families.values()) {
    const earliestFiling =
      family.members
        .map((member) => member.filingDate)
        .filter((date): date is string => Boolean(date))
        .sort()[0] ?? null
    const titleMember = [...family.members].sort(compareFamilyMembers)[0]
    const spend = spendByFamily[family.spendKey] ?? null
    const aggregate: FamilyAggregate = {
      familyId: family.rowKey,
      title: titleMember?.title ?? family.spendKey,
      apps: family.members.length,
      grants: family.members.filter((member) => member.grantDate).length,
      earliestFiling,
      spend,
      docketingEnabled: config.sources.docketing,
      spendEnabled: config.sources.spend,
    }
    rows.push({
      key: family.rowKey,
      properties: buildFamilyProperties(aggregate, lastSync),
      fingerprintBasis: {
        family: aggregate,
        identity: family.identity,
        spendKey: family.spendKey,
      },
    })
  }

  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.key)) {
      throw new Error(`[join] duplicate portfolio row key "${row.key}"`)
    }
    seen.add(row.key)
  }
  rows.sort((a, b) => a.key.localeCompare(b.key))
  return rows
}

// Pure/network-free reconstruction used after fetching and by subsequent
// write-side pages. A frozen snapshot set always yields the same ordered rows.
export function assemblePortfolioRows(opts: {
  snapshots: SourceSnapshots
  nowIso: string
}): PortfolioRow[] {
  const uspto = requireSnapshot<PatentRecord[]>(
    opts.snapshots,
    "uspto",
    config.sources.uspto,
    []
  )
  const epo = requireSnapshot<PatentRecord[]>(
    opts.snapshots,
    "epo",
    config.sources.epo,
    []
  )
  const records = canonicalizeRecords([
    ...officeRecords(uspto, "uspto", "USPTO", "US"),
    ...officeRecords(epo, "epo", "EPO", "EP"),
  ])
  const rawDocket = requireSnapshot<unknown>(
    opts.snapshots,
    "docketing",
    config.sources.docketing,
    {}
  )
  const docket = config.sources.docketing
    ? projectDocketLookup(rawDocket, records)
    : {}
  const prepared = preparePortfolio(records, docket)
  const rawSpend = requireSnapshot<unknown>(
    opts.snapshots,
    "spend",
    config.sources.spend,
    {}
  )
  const spend = config.sources.spend
    ? projectSpendLookup(rawSpend, prepared.spendKeys)
    : {}
  return rowsFromPrepared(prepared, spend, opts.nowIso)
}

export type BuildOpts = {
  mode: SyncMode
  nowIso: string
  prevSnapshots?: SourceSnapshots
  prevHealth?: SourceHealth
  pacers: { uspto: () => Promise<void>; epo: () => Promise<void> }
}

export async function buildPortfolioRows(opts: BuildOpts): Promise<{
  rows: PortfolioRow[]
  snapshots: SourceSnapshots
  sourceHealth: SourceHealth
}> {
  // USPTO and EPO run sequentially in one execute. A single wall-clock
  // deadline prevents their independent pagination budgets from combining
  // into an overlong worker run. SourceRunner turns this into LKG fallback
  // during resilient deltas and a fail-closed error during strict backfills.
  const acquisitionDeadlineMs = Date.now() + 4 * 60 * 1000
  const runner = new SourceRunner({
    mode: opts.mode,
    prevSnapshots: opts.prevSnapshots,
    prevHealth: opts.prevHealth,
    nowIso: opts.nowIso,
  })

  if (!config.sources.uspto && !config.sources.epo) {
    throw new Error(
      "No patent-office source enabled — set config.sources.uspto and/or config.sources.epo to true (at least one is required)."
    )
  }

  const fetchedRecords: PatentRecord[] = []
  if (config.sources.uspto) {
    const records = await runner.run("uspto", async () =>
      officeRecords(
        await fetchUsptoRecords(
          config.applicants,
          opts.pacers.uspto,
          acquisitionDeadlineMs
        ),
        "uspto",
        "USPTO",
        "US"
      )
    )
    fetchedRecords.push(...officeRecords(records, "uspto", "USPTO", "US"))
  }
  if (config.sources.epo) {
    const records = await runner.run("epo", async () =>
      officeRecords(
        await fetchEpoRecords(
          config.applicants,
          opts.pacers.epo,
          acquisitionDeadlineMs
        ),
        "epo",
        "EPO",
        "EP"
      )
    )
    fetchedRecords.push(...officeRecords(records, "epo", "EPO", "EP"))
  }

  const records = canonicalizeRecords(fetchedRecords)
  let docket: DocketLookup = {}
  if (config.sources.docketing) {
    const returned = await runner.run("docketing", async () => {
      const projected = projectDocketLookup(
        await docketingAdapter.lookup(records),
        records
      )
      // Cross-record conflicts (for example two family IDs within one
      // continuity component) are also adapter failures, not healthy data.
      preparePortfolio(records, projected)
      return projected
    })
    // A resilient run may have returned a pre-projection legacy snapshot.
    // Validate it before use and persist the canonical projection while
    // preserving the original lastSuccessAt timestamp.
    docket = projectDocketLookup(returned, records, {
      dropUnrequested: runner.sourceHealth.docketing?.servedFromCache === true,
    })
    preparePortfolio(records, docket)
    const snapshot = runner.snapshots.docketing
    if (snapshot) snapshot.data = docket
  }

  const prepared = preparePortfolio(records, docket)
  if (config.sources.spend) {
    const returned = await runner.run("spend", async () =>
      projectSpendLookup(
        await spendAdapter.lookup(prepared.spendKeys),
        prepared.spendKeys
      )
    )
    const spend = projectSpendLookup(returned, prepared.spendKeys, {
      dropUnrequested: runner.sourceHealth.spend?.servedFromCache === true,
    })
    const snapshot = runner.snapshots.spend
    if (snapshot) snapshot.data = spend
  }

  return {
    rows: assemblePortfolioRows({
      snapshots: runner.snapshots,
      nowIso: opts.nowIso,
    }),
    snapshots: runner.snapshots,
    sourceHealth: runner.sourceHealth,
  }
}
