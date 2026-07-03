import { createHash } from "node:crypto"

import type {
  PublishPreparedReleaseInput,
  PublishReceipt,
  RequiredAsset,
  RequiredCheck,
} from "./types.js"

export const MAX_REQUIRED_CHECKS = 20
export const MAX_REQUIRED_ASSETS = 100
export const MAX_TAG_BYTES = 128
export const MAX_CHECK_NAME_BYTES = 160
export const MAX_ASSET_NAME_BYTES = 255
export const MAX_APPROVAL_VALUE_BYTES = 160
export const MAX_RETRY_AFTER_SECONDS = 86_400

const SHA256 = /^[a-f0-9]{64}$/
const FULL_COMMIT_SHA = /^[a-f0-9]{40}$/
const PAGE_ID =
  /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/
const TAG = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

export class PolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PolicyError"
  }
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

export function boundedRetryAfterSeconds(
  value: number | null | undefined
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null
  }
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(0, Math.ceil(value)))
}

export function normalizeRepository(value: string): string {
  const parts = value.trim().split("/")
  if (
    parts.length !== 2 ||
    !OWNER.test(parts[0]) ||
    !REPOSITORY.test(parts[1]) ||
    parts[1] === "." ||
    parts[1] === ".."
  ) {
    throw new PolicyError("repository must be one owner/repository pair")
  }
  return `${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`
}

export function normalizePageId(value: string): string {
  const compact = value.trim().replaceAll("-", "").toLowerCase()
  if (!PAGE_ID.test(value.trim()) || compact.length !== 32) {
    throw new PolicyError("approvalPageId must be a Notion page UUID")
  }
  return compact
}

function boundedText(name: string, value: string, maxBytes: number): void {
  if (!value || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new PolicyError(`${name} must be 1-${maxBytes} UTF-8 bytes`)
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new PolicyError(`${name} must not contain control characters`)
  }
}

function validateTag(tag: string): void {
  boundedText("tag", tag, MAX_TAG_BYTES)
  if (
    !TAG.test(tag) ||
    tag.startsWith("refs/") ||
    tag.includes("..") ||
    tag.includes("@{") ||
    tag.includes("//") ||
    tag.endsWith(".") ||
    tag.endsWith("/") ||
    tag.endsWith(".lock")
  ) {
    throw new PolicyError("tag is outside this tool's safe Git ref subset")
  }
}

function validateChecks(checks: RequiredCheck[]): void {
  if (checks.length < 1 || checks.length > MAX_REQUIRED_CHECKS) {
    throw new PolicyError(
      `requiredChecks must contain 1-${MAX_REQUIRED_CHECKS} gates`
    )
  }
  const seen = new Set<string>()
  for (const check of checks) {
    boundedText("requiredChecks[].name", check.name, MAX_CHECK_NAME_BYTES)
    if (check.kind !== "check_run") {
      throw new PolicyError("requiredChecks supports only check_run gates")
    }
    if (!Number.isSafeInteger(check.appId) || check.appId <= 0) {
      throw new PolicyError("requiredChecks[].appId must be a positive integer")
    }
    const key = `${check.kind}:${check.name}:${check.appId}`
    if (seen.has(key)) throw new PolicyError(`duplicate required check: ${key}`)
    seen.add(key)
  }
}

function validateAssets(assets: RequiredAsset[]): void {
  if (assets.length > MAX_REQUIRED_ASSETS) {
    throw new PolicyError(
      `requiredAssets must contain at most ${MAX_REQUIRED_ASSETS} assets`
    )
  }
  const seen = new Set<string>()
  for (const asset of assets) {
    boundedText("requiredAssets[].name", asset.name, MAX_ASSET_NAME_BYTES)
    if (asset.name === "." || asset.name === ".." || asset.name.includes("/")) {
      throw new PolicyError("asset names must be plain filenames")
    }
    if (!Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 0) {
      throw new PolicyError(
        "requiredAssets[].sizeBytes must be a nonnegative integer"
      )
    }
    if (!SHA256.test(asset.sha256)) {
      throw new PolicyError("requiredAssets[].sha256 must be lowercase SHA-256")
    }
    if (seen.has(asset.name)) {
      throw new PolicyError(`duplicate required asset: ${asset.name}`)
    }
    seen.add(asset.name)
  }
}

export function canonicalPacket(input: PublishPreparedReleaseInput): string {
  return JSON.stringify({
    version: 1,
    approvalPageId: normalizePageId(input.approvalPageId),
    approvalRevision: input.approvalRevision,
    repository: normalizeRepository(input.repository),
    releaseId: input.releaseId,
    tag: input.tag,
    targetCommit: input.targetCommit,
    nameSha256: input.nameSha256,
    bodySha256: input.bodySha256,
    prerelease: input.prerelease,
    makeLatest: input.makeLatest,
    requiredChecks: input.requiredChecks
      .map(({ kind, name, appId }) => ({ kind, name, appId }))
      .sort((a, b) =>
        compareCanonical(
          `${a.kind}:${a.name}:${a.appId ?? ""}`,
          `${b.kind}:${b.name}:${b.appId ?? ""}`
        )
      ),
    requiredAssets: input.requiredAssets
      .map(({ name, sizeBytes, sha256: digest }) => ({
        name,
        sizeBytes,
        sha256: digest,
      }))
      .sort((a, b) => compareCanonical(a.name, b.name)),
  })
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function hasExactKeys(value: object, expected: string[]): boolean {
  return (
    Object.keys(value).sort().join("\u0000") ===
    [...expected].sort().join("\u0000")
  )
}

export function validateInput(input: PublishPreparedReleaseInput): void {
  normalizePageId(input.approvalPageId)
  normalizeRepository(input.repository)
  boundedText(
    "approvalRevision",
    input.approvalRevision,
    MAX_APPROVAL_VALUE_BYTES
  )
  if (!SHA256.test(input.approvalFingerprint)) {
    throw new PolicyError("approvalFingerprint must be lowercase SHA-256")
  }
  if (!Number.isSafeInteger(input.releaseId) || input.releaseId <= 0) {
    throw new PolicyError("releaseId must be a positive integer")
  }
  validateTag(input.tag)
  if (!FULL_COMMIT_SHA.test(input.targetCommit)) {
    throw new PolicyError(
      "targetCommit must be a full lowercase 40-character SHA"
    )
  }
  if (!SHA256.test(input.nameSha256) || !SHA256.test(input.bodySha256)) {
    throw new PolicyError("nameSha256 and bodySha256 must be lowercase SHA-256")
  }
  if (input.prerelease && input.makeLatest === "true") {
    throw new PolicyError("a prerelease cannot use makeLatest=true")
  }
  validateChecks(input.requiredChecks)
  validateAssets(input.requiredAssets)

  const calculated = sha256(canonicalPacket(input))
  if (calculated !== input.approvalFingerprint) {
    throw new PolicyError(
      "approvalFingerprint does not match the canonical approved packet"
    )
  }
}

export function buildIdentity(
  input: PublishPreparedReleaseInput,
  repositoryId: number
): {
  idempotencyKey: string
  operationId: string
  resumeToken: string
  inputFingerprint: string
  resourceKey: string
} {
  const inputFingerprint = sha256(canonicalPacket(input))
  const keyMaterial = [
    "github-release-v1",
    normalizeRepository(input.repository),
    String(input.releaseId),
    normalizePageId(input.approvalPageId),
    input.approvalRevision,
    inputFingerprint,
  ].join(":")
  const digest = sha256(keyMaterial)
  return {
    idempotencyKey: `github-release:${digest}`,
    operationId: `ghrel_${digest.slice(0, 24)}`,
    resumeToken: `ghrel_resume_${sha256(`resume:${digest}`).slice(0, 24)}`,
    inputFingerprint,
    resourceKey: `repository:${repositoryId}:release:${input.releaseId}`,
  }
}

export function assertReceipt(receipt: PublishReceipt): void {
  const validStatuses = new Set([
    "completed",
    "no_op",
    "blocked",
    "conflict",
    "partial_failure",
    "ambiguous",
  ])
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    !hasExactKeys(receipt, [
      "ok",
      "status",
      "operationId",
      "idempotencyKey",
      "changed",
      "replay",
      "published",
      "records",
      "steps",
      "warnings",
      "retryable",
      "retryAfterSeconds",
      "resumeToken",
      "repair",
    ]) ||
    !validStatuses.has(receipt.status)
  )
    throw new Error("invalid receipt status")
  if (receipt.ok !== ["completed", "no_op"].includes(receipt.status)) {
    throw new Error("receipt ok/status mismatch")
  }
  if (
    typeof receipt.operationId !== "string" ||
    receipt.operationId.length < 1 ||
    receipt.operationId.length > 100 ||
    typeof receipt.idempotencyKey !== "string" ||
    receipt.idempotencyKey.length < 1 ||
    receipt.idempotencyKey.length > 200 ||
    typeof receipt.changed !== "boolean" ||
    typeof receipt.replay !== "boolean" ||
    typeof receipt.published !== "boolean" ||
    !Array.isArray(receipt.steps) ||
    !Array.isArray(receipt.records) ||
    !Array.isArray(receipt.warnings) ||
    typeof receipt.retryable !== "boolean" ||
    (receipt.retryAfterSeconds !== null &&
      (!Number.isSafeInteger(receipt.retryAfterSeconds) ||
        receipt.retryAfterSeconds < 0 ||
        receipt.retryAfterSeconds > MAX_RETRY_AFTER_SECONDS)) ||
    (receipt.resumeToken !== null &&
      (typeof receipt.resumeToken !== "string" ||
        receipt.resumeToken.length > 100)) ||
    (receipt.repair !== null &&
      (typeof receipt.repair !== "string" || receipt.repair.length > 500))
  ) {
    throw new Error("receipt has invalid scalar fields")
  }
  if (
    receipt.steps.length > 12 ||
    receipt.records.length > 3 ||
    receipt.warnings.length > 5
  ) {
    throw new Error("receipt exceeds output bounds")
  }
  for (const record of receipt.records) {
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      !hasExactKeys(record, ["system", "kind", "id", "url", "action"]) ||
      !["github", "notion"].includes(record.system) ||
      !["release", "release_packet"].includes(record.kind) ||
      typeof record.id !== "string" ||
      record.id.length < 1 ||
      record.id.length > 100 ||
      typeof record.url !== "string" ||
      record.url.length > 2_048 ||
      !["published", "observed", "receipt_written"].includes(record.action)
    ) {
      throw new Error("receipt contains an invalid record")
    }
    let url: URL
    try {
      url = new URL(record.url)
    } catch {
      throw new Error("receipt contains an invalid record URL")
    }
    if (url.protocol !== "https:") {
      throw new Error("receipt record URL must use HTTPS")
    }
    if (
      (record.system === "github" &&
        (record.kind !== "release" ||
          !["published", "observed"].includes(record.action) ||
          url.hostname !== "github.com")) ||
      (record.system === "notion" &&
        (record.kind !== "release_packet" ||
          record.action !== "receipt_written"))
    ) {
      throw new Error("receipt record semantics are inconsistent")
    }
  }
  for (const item of receipt.steps) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      !hasExactKeys(item, ["name", "status", "detail"]) ||
      typeof item.name !== "string" ||
      item.name.length < 1 ||
      item.name.length > 100 ||
      !["completed", "skipped", "failed", "unknown"].includes(item.status) ||
      typeof item.detail !== "string" ||
      item.detail.length > 300
    ) {
      throw new Error("receipt contains an invalid step")
    }
  }
  if (
    receipt.warnings.some(
      (warning) => typeof warning !== "string" || warning.length > 500
    )
  ) {
    throw new Error("receipt contains an invalid warning")
  }
  if (JSON.stringify(receipt).length > 8_000) {
    throw new Error("receipt exceeds 8,000 characters")
  }
}
