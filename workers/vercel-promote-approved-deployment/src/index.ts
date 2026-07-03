import { randomUUID } from "node:crypto"
import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"
import { loadConfig } from "./config.js"
import { promoteApprovedDeployment } from "./promote.js"
import { rollbackApprovedDeployment } from "./rollback.js"
import { RedisOperationStore } from "./redis.js"
import type { NotionClientLike, PromoteInput, RollbackInput } from "./types.js"
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
      "ambiguous",
      "rollback_recommended"
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
  aliasState: j
    .array(
      j.object({
        domain: j
          .string()
          .describe("Exact provider-reported production domain."),
        deploymentId: j
          .string()
          .nullable()
          .describe("Deployment currently mapped to the domain, or null."),
      }),
      { minItems: 0 }
    )
    .describe("Complete ordered production alias state."),
  healthFailure: j
    .object({
      path: j.string().describe("Fixed health path that failed."),
      outcome: j
        .enum("transport_error", "http_status")
        .describe("Bounded failure class."),
      status: j
        .integer()
        .nullable()
        .describe("HTTP status, or null for transport failure."),
    })
    .nullable()
    .describe(
      "Bounded post-promotion health evidence for a rollback recommendation."
    ),
  rollbackRequested: j
    .boolean()
    .describe("Always false: promotion never performs rollback."),
  incidentReceiptHash: j
    .string()
    .nullable()
    .describe("Canonical promotion incident SHA-256 hash."),
  freshApprovalInstruction: j
    .string()
    .nullable()
    .describe("Fresh rollback approval instructions."),
  rollbackTargetGitSha: j
    .string()
    .nullable()
    .describe("Incident-recorded prior deployment Git SHA."),
  rollbackTargetGitBranch: j
    .string()
    .nullable()
    .describe("Incident-recorded prior deployment Git branch."),
  residualRaceWarning: j
    .string()
    .describe("Explicit provider no-CAS residual race disclosure."),
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

const rollbackResultSchema = j.object({
  ok: j
    .boolean()
    .describe("True only for completed or canonical replay outcomes."),
  operationId: j
    .string()
    .describe("Stable vrb_ ID for this exact rollback authority."),
  idempotencyKey: j.string().describe("Stable rollback operation identity."),
  status: j
    .enum(
      "completed",
      "no_op",
      "blocked",
      "conflict",
      "partial_failure",
      "ambiguous"
    )
    .describe("Governed rollback outcome."),
  changed: j
    .boolean()
    .describe(
      "Whether this operation is treated as changing routing; fresh observed-only adoption is false and causality remains separate."
    ),
  replay: j.boolean().describe("True only for a completed read-only replay."),
  preconditionsVerified: j
    .boolean()
    .describe("Whether incident, fresh approval, and provider gates passed."),
  rollbackRequested: j
    .boolean()
    .describe("Whether this operation issued its sole rollback POST."),
  receiptWritten: j
    .boolean()
    .describe("Whether the exact rollback receipt was read back from Notion."),
  causality: j
    .enum("provider_accepted", "observed_only", "none")
    .describe("What the Worker can prove about causality."),
  disposition: j
    .enum(
      "rolled_back",
      "observed_restored",
      "candidate_unchanged",
      "split",
      "third_deployment",
      "unknown"
    )
    .describe("Authoritative live routing disposition."),
  rollbackRequestAccepted: j
    .boolean()
    .describe("Whether HTTP 201 was durably observed."),
  requestDisposition: j
    .enum("accepted", "outcome_unknown", "not_sent")
    .describe(
      "Canonical provider-request disposition retained in the receipt."
    ),
  resumeMode: j
    .enum("none", "reconcile_only", "receipt_only", "complete")
    .describe("Only permitted behavior for an exact replay."),
  retryable: j
    .boolean()
    .describe("Whether the same operation may be resumed read-only."),
  retryAfterMs: j
    .integer()
    .nullable()
    .describe(
      "Bounded provider retry timing retained for operator planning; never causes an automatic repost."
    ),
  resumeToken: j
    .string()
    .nullable()
    .describe("Stable reconciliation token, or null."),
  repairInstruction: j
    .string()
    .nullable()
    .describe("Required human/operator action, or null."),
  originalPromotionOperationId: j
    .string()
    .describe("Durable vpa_ promotion incident operation."),
  originalIncidentReceiptHash: j
    .string()
    .describe("Canonical incident receipt SHA-256."),
  teamId: j.string().describe("Exact Vercel team ID."),
  projectId: j.string().describe("Exact Vercel project ID."),
  candidateDeploymentId: j.string().describe("Unhealthy promoted candidate."),
  rollbackDeploymentId: j
    .string()
    .describe("Exact incident-recorded prior deployment."),
  currentDeploymentId: j
    .string()
    .nullable()
    .describe("Unanimous current deployment, or null."),
  rollbackDeploymentUrl: j
    .string()
    .nullable()
    .describe("Canonical target deployment hostname."),
  rollbackGitSha: j
    .string()
    .describe("Target Git SHA derived from the canonical incident."),
  rollbackGitBranch: j
    .string()
    .describe("Target Git branch derived from the canonical incident."),
  promotionApprovalPageId: j
    .uuid()
    .describe("Original promotion approval page."),
  promotionIncidentPageId: j
    .uuid()
    .describe("Page containing the canonical promotion incident."),
  rollbackApprovalPageId: j.uuid().describe("Fresh rollback approval page."),
  rollbackApprovalRevision: j
    .string()
    .describe("Fresh rollback approval revision."),
  rollbackApprovalFingerprint: j
    .string()
    .describe("Fresh rollback approval fingerprint."),
  productionDomains: j
    .array(j.string())
    .describe("Exact complete production-domain set."),
  aliasState: j
    .array(
      j.object({
        domain: j.string().describe("Exact production domain."),
        deploymentId: j
          .string()
          .nullable()
          .describe("Observed deployment mapping."),
      }),
      { minItems: 1 }
    )
    .describe("Complete ordered production alias state."),
  healthPaths: j
    .array(j.string())
    .describe("Fixed target health paths verified."),
  healthFailure: j
    .object({
      path: j.string().describe("Fixed target health path that failed."),
      outcome: j
        .enum("transport_error", "http_status")
        .describe("Bounded target health failure class."),
      status: j
        .integer()
        .nullable()
        .describe("HTTP status, or null for transport failure."),
    })
    .nullable()
    .describe("Bounded post-rollback target health evidence, or null."),
  receiptWrittenAt: j
    .datetime()
    .nullable()
    .describe("Verified Notion readback time, or null."),
  startedAt: j.datetime().describe("Durable rollback operation creation time."),
  completedAt: j
    .datetime()
    .nullable()
    .describe("Verified restoration time, or null."),
  warnings: j
    .array(j.string(), { minItems: 1 })
    .describe("Bounded safety and causality warnings."),
  residualRaceWarning: j
    .string()
    .describe("Explicit provider no-CAS race disclosure."),
  steps: j
    .array(
      j.object({
        name: j
          .enum(
            "incident",
            "approval",
            "preflight",
            "rollback",
            "reconciliation",
            "receipt"
          )
          .describe("Rollback workflow step."),
        state: j
          .enum("completed", "skipped", "blocked", "failed", "pending")
          .describe("Step outcome."),
      }),
      { minItems: 1 }
    )
    .describe("Deterministic rollback workflow receipt."),
  message: j.string().describe("Concise outcome and next step."),
})

worker.tool("rollbackApprovedDeployment", {
  title: "Roll back an approved Vercel promotion incident",
  description:
    "Restore the exact prior Vercel production deployment recorded by a canonical post-promotion health incident, but only with a separate fresh Notion rollback approval bound to that incident page and hash. Revalidates both pages, both deployment Git identities, exact current aliases, target health, and rolling-release state; persists a non-expiring fence before one rollback POST and never repeats it. Observed restoration without a durable HTTP 201 is explicitly reported as observed-only. Vercel has no rollback compare-and-swap, so a residual external-writer race remains.",
  schema: j.object({
    rollbackApprovalPageId: j
      .uuid()
      .describe("Fresh Notion rollback approval page UUID."),
    rollbackApprovalRevision: j
      .string()
      .describe("Exact stable rollback approval revision."),
    rollbackApprovalFingerprint: j
      .string()
      .describe("Exact lowercase SHA-256 of the rollback approval packet."),
    originalPromotionOperationId: j
      .string()
      .describe("Exact vpa_ operation ID from the promotion incident."),
    promotionIncidentPageId: j
      .uuid()
      .describe(
        "Exact original page holding the canonical promotion incident."
      ),
    originalIncidentReceiptHash: j
      .string()
      .describe("Exact lowercase SHA-256 of the canonical incident JSON."),
    teamId: j.string().describe("Exact incident-approved Vercel team_ ID."),
    projectId: j.string().describe("Exact incident-approved Vercel prj_ ID."),
    candidateDeploymentId: j
      .string()
      .describe("Exact unhealthy promoted candidate dpl_ ID."),
    rollbackDeploymentId: j
      .string()
      .describe("Exact prior production dpl_ ID recorded by the incident."),
  }),
  outputSchema: rollbackResultSchema,
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
    return rollbackApprovedDeployment(input as RollbackInput, config, {
      notion: notion as unknown as NotionClientLike,
      store,
      vercel,
      now,
      sleep,
      randomToken: randomUUID,
    })
  },
})
