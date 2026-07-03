import { j } from "@notionhq/workers/schema-builder"

export const publishPreparedReleaseSchema = j.object({
  approvalPageId: j
    .string()
    .describe("UUID of the approved Notion release-packet database page."),
  approvalRevision: j
    .string()
    .describe(
      "Exact value in the packet's configured Approval revision property."
    ),
  approvalFingerprint: j
    .string()
    .describe("Lowercase SHA-256 of the canonical approved packet."),
  repository: j
    .string()
    .describe("Allowlisted GitHub owner/repository; URLs are not accepted."),
  releaseId: j
    .integer()
    .describe("Numeric ID of the one expected GitHub draft release."),
  tag: j
    .string()
    .describe(
      "Exact existing tag ref, in the tool's bounded safe Git-ref subset."
    ),
  targetCommit: j
    .string()
    .describe("Full lowercase 40-character commit SHA approved for the tag."),
  nameSha256: j
    .string()
    .describe(
      "Lowercase SHA-256 of the exact draft release name (empty string if null)."
    ),
  bodySha256: j
    .string()
    .describe(
      "Lowercase SHA-256 of the exact UTF-8 draft release body (empty if null)."
    ),
  prerelease: j
    .boolean()
    .describe("Exact approved prerelease flag; this tool does not change it."),
  makeLatest: j
    .enum("true", "false", "legacy")
    .describe(
      "Approved GitHub make_latest policy passed to the publication PATCH."
    ),
  requiredChecks: j
    .array(
      j.object({
        kind: j
          .enum("check_run")
          .describe("GitHub Checks run bound to one exact GitHub App."),
        name: j.string().describe("Exact check-run name."),
        appId: j
          .integer()
          .describe(
            "Exact positive GitHub App ID that must own the successful check run."
          ),
      }),
      { minItems: 1 }
    )
    .describe("One to 20 terminal success gates, enforced again in code."),
  requiredAssets: j
    .array(
      j.object({
        name: j.string().describe("Exact release asset filename."),
        sizeBytes: j.integer().describe("Exact nonnegative asset size."),
        sha256: j
          .string()
          .describe("Lowercase SHA-256 matching GitHub's asset digest."),
      })
    )
    .describe("Exact complete release asset manifest; at most 100 entries."),
})

const recordSchema = j.object({
  system: j.enum("github", "notion"),
  kind: j.enum("release", "release_packet"),
  id: j.string(),
  url: j.string(),
  action: j.enum("published", "observed", "receipt_written"),
})

const stepSchema = j.object({
  name: j.string(),
  status: j.enum("completed", "skipped", "failed", "unknown"),
  detail: j.string(),
})

export const publishReceiptSchema = j.object({
  ok: j.boolean(),
  status: j.enum(
    "completed",
    "no_op",
    "blocked",
    "conflict",
    "partial_failure",
    "ambiguous"
  ),
  operationId: j.string(),
  idempotencyKey: j.string(),
  changed: j.boolean(),
  replay: j.boolean(),
  published: j.boolean(),
  records: j.array(recordSchema),
  steps: j.array(stepSchema),
  warnings: j.array(j.string()),
  retryable: j.boolean(),
  retryAfterSeconds: j
    .integer()
    .nullable()
    .describe(
      "Bounded provider or lease delay in seconds before the next safe retry."
    ),
  resumeToken: j.string().nullable(),
  repair: j.string().nullable(),
})
