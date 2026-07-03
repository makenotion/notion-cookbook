import { randomUUID } from "node:crypto"
import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"
import { loadConfig } from "./config.js"
import { promoteApprovedDeployment } from "./promote.js"
import { RedisOperationStore } from "./redis.js"
import type { NotionClientLike, PromoteInput } from "./types.js"
import { VercelClient } from "./vercel.js"

const worker = new Worker()
export default worker

const resultSchema = j.object({
  ok: j
    .boolean()
    .describe("True only for completed and canonical no-op outcomes."),
  operationId: j
    .string()
    .describe("Stable ID for this exact approved operation."),
  idempotencyKey: j
    .string()
    .describe("Stable replay key; identical to operationId for this version."),
  status: j
    .enum(
      "completed",
      "no_op",
      "blocked",
      "conflict",
      "partial_failure",
      "ambiguous"
    )
    .describe("Governed terminal or resumable outcome."),
  changed: j
    .boolean()
    .describe(
      "Whether this operation authoritatively changed production state."
    ),
  replay: j
    .boolean()
    .describe(
      "True only when returning an already-complete canonical operation."
    ),
  preconditionsVerified: j
    .boolean()
    .describe(
      "Whether approval and provider preflight completed before the outcome."
    ),
  promotionRequested: j
    .boolean()
    .describe("Whether this operation issued Vercel's promotion POST."),
  receiptWritten: j
    .boolean()
    .describe("Whether the compact receipt is present on the approval page."),
  records: j
    .array(
      j.object({
        kind: j
          .enum("approval", "project", "deployment", "production_domain")
          .describe("Canonical record type."),
        system: j.enum("notion", "vercel").describe("System of record."),
        id: j.string().describe("Stable record identifier."),
        url: j
          .string()
          .nullable()
          .describe(
            "Canonical record URL, or null before deployment discovery."
          ),
        action: j
          .enum("verified", "promoted", "observed", "routed", "receipt_written")
          .describe("Governed action for this record."),
        state: j.string().describe("Observed or terminal record state."),
      }),
      { minItems: 1 }
    )
    .describe("Canonical records affected or verified by the operation."),
  steps: j
    .array(
      j.object({
        name: j
          .enum(
            "approval",
            "preflight",
            "promotion",
            "reconciliation",
            "receipt"
          )
          .describe("Workflow step."),
        state: j
          .enum("completed", "skipped", "blocked", "failed", "pending")
          .describe("Terminal or resumable step state."),
      }),
      { minItems: 1 }
    )
    .describe("Per-step execution receipt in deterministic order."),
  warnings: j.array(j.string()).describe("Bounded safety warnings."),
  retryable: j
    .boolean()
    .describe("Whether the exact same approved operation may be resumed."),
  retryAfterMs: j
    .integer()
    .nullable()
    .describe(
      "Provider-requested retry delay for a definite 429, otherwise null."
    ),
  resumeToken: j
    .string()
    .nullable()
    .describe("Stable token for a safe resume, otherwise null."),
  repairInstruction: j
    .string()
    .nullable()
    .describe("Required operator or agent repair action, otherwise null."),
  teamId: j.string().describe("Verified allowlisted Vercel team ID."),
  projectId: j.string().describe("Verified allowlisted Vercel project ID."),
  deploymentId: j.string().describe("Exact approved deployment ID."),
  deploymentUrl: j
    .string()
    .nullable()
    .describe(
      "Canonical staged deployment URL after discovery, otherwise null."
    ),
  previousDeploymentId: j
    .string()
    .nullable()
    .describe("Deployment expected to own production before promotion."),
  currentDeploymentId: j
    .string()
    .nullable()
    .describe("Authoritative current deployment when all domains agree."),
  gitSha: j.string().describe("Verified Git commit SHA."),
  gitBranch: j.string().describe("Verified Git branch."),
  approvalPageId: j.uuid().describe("Notion approval page ID."),
  approvalRevision: j.string().describe("Stable approved revision token."),
  approvalFingerprint: j
    .string()
    .describe("Verified SHA-256 approval packet fingerprint."),
  checkIds: j
    .array(j.string())
    .describe(
      "Stable Vercel Deployment Check IDs verified by the Worker; empty only when validation blocks before policy selection."
    ),
  checkNames: j
    .array(j.string())
    .describe(
      "Configured check display names, or IDs when names are unpinned."
    ),
  healthPaths: j
    .array(j.string())
    .describe(
      "Fixed allowlisted deployment health paths verified; empty only when validation blocks before policy selection."
    ),
  productionDomains: j
    .array(j.string())
    .describe(
      "Exact complete provider-reported production-domain set reconciled; empty only when validation blocks before policy selection."
    ),
  startedAt: j.datetime().describe("Time this durable operation was created."),
  completedAt: j
    .datetime()
    .nullable()
    .describe("Time production convergence was verified, or null."),
  message: j.string().describe("Concise next-step or completion explanation."),
})

worker.tool("promoteApprovedDeployment", {
  title: "Promote approved Vercel deployment",
  description:
    "Promote one exact Notion-approved staged Vercel production deployment only while its immutable revision, fingerprint, Git identity, current production deployment, stable Deployment Checks, and fixed health checks remain valid. Returns a durable receipt or a conflict/partial/ambiguous state that can be resumed without blindly repeating the mutation. Do not use this tool to choose a deployment, bypass checks, rebuild, roll back, or force production traffic.",
  schema: j.object({
    approvalPageId: j
      .uuid()
      .describe("UUID of the Notion page containing the approval packet."),
    approvalRevision: j
      .string()
      .describe(
        "Exact 1–100 character value of the page's stable Approval revision property; no surrounding whitespace or control characters."
      ),
    approvalFingerprint: j
      .string()
      .describe(
        "Exactly 64 lowercase hexadecimal characters: the SHA-256 fingerprint stored on the approval page."
      ),
    teamId: j
      .string()
      .describe(
        "Exact approved Vercel team_ ID, at most 100 characters, using an alphanumeric suffix."
      ),
    projectId: j
      .string()
      .describe(
        "Exact approved Vercel prj_ ID, at most 100 characters, using an alphanumeric suffix."
      ),
    deploymentId: j
      .string()
      .describe(
        "Exact approved staged Vercel dpl_ ID, at most 100 characters, using an alphanumeric suffix."
      ),
    expectedGitSha: j
      .string()
      .describe(
        "Exact lowercase 40- or 64-character hexadecimal Git SHA approved for production."
      ),
    expectedGitBranch: j
      .string()
      .describe(
        "Exact 1–256 character approved Git branch; no surrounding whitespace or control characters."
      ),
    expectedCurrentDeploymentId: j
      .string()
      .describe(
        "Exact dpl_ ID, at most 100 characters, expected to own the complete production-domain set now."
      ),
  }),
  outputSchema: resultSchema,
  hints: { readOnlyHint: false },
  execute: async (input, { notion }) => {
    const config = loadConfig()
    const sleep = (milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
    const now = () => new Date()
    const store = new RedisOperationStore({
      baseUrl: config.redisUrl,
      token: config.redisToken,
      timeoutMs: config.requestTimeoutMs,
    })
    const vercel = new VercelClient({
      token: config.vercelToken,
      protectionBypassSecret: config.protectionBypassSecret,
      requestTimeoutMs: config.requestTimeoutMs,
      healthTimeoutMs: config.healthTimeoutMs,
      sleep,
      now,
    })
    return promoteApprovedDeployment(input as PromoteInput, config, {
      notion: notion as unknown as NotionClientLike,
      store,
      vercel,
      now,
      sleep,
      randomToken: randomUUID,
    })
  },
})
