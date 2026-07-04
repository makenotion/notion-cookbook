import { randomUUID } from "node:crypto"
import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"
import { loadConfig } from "./config.js"
import { IntercomClient } from "./intercom.js"
import { JiraClient } from "./jira.js"
import { escalateCustomerIssue } from "./orchestrator.js"
import { RedisOperationStore } from "./redis.js"
import type { EscalationInput, NotionClientLike } from "./types.js"

const worker = new Worker()
export default worker

const resultSchema = j.object({
  ok: j
    .boolean()
    .describe("True only for completed and canonical no-op replay outcomes."),
  status: j
    .enum(
      "completed",
      "no_op",
      "blocked",
      "conflict",
      "partial_failure",
      "ambiguous"
    )
    .describe("Governed terminal or safely resumable outcome."),
  operationId: j
    .string()
    .describe("Stable icj_ operation ID for this exact approval."),
  idempotencyKey: j
    .string()
    .describe("Stable replay key, equal to operationId."),
  changed: j
    .boolean()
    .describe(
      "Whether this invocation is known to have changed a provider or the Notion receipt."
    ),
  replay: j
    .boolean()
    .describe(
      "True only when permanent Redis proof and mapping verify the canonical receipt replay."
    ),
  preconditionsVerified: j
    .boolean()
    .describe("Whether current Notion and Intercom gates passed."),
  issueCreated: j
    .boolean()
    .describe("Whether this invocation created the Jira issue."),
  issueEnriched: j
    .boolean()
    .describe("Whether this invocation added the bounded enrichment comment."),
  receiptWritten: j
    .boolean()
    .describe(
      "Whether the canonical Notion receipt is present and backed by permanent Redis proof."
    ),
  customerVisibleReplySent: j
    .boolean()
    .describe(
      "Always false. The tool can only create an internal Intercom note."
    ),
  approvalPageId: j
    .uuid()
    .describe("Exact Notion page whose authority was consumed."),
  approvalRevision: j
    .string()
    .describe("Exact stable approved revision consumed."),
  approvalFingerprint: j
    .string()
    .describe("Exact SHA-256 packet fingerprint consumed."),
  mappingId: j
    .string()
    .describe("Permanent Redis source-to-Jira mapping identity."),
  intercomTeamId: j
    .string()
    .nullable()
    .describe(
      "Configured Intercom team route, or null before policy selection."
    ),
  intercomTagId: j
    .string()
    .nullable()
    .describe(
      "Configured Intercom escalation tag, or null before policy selection."
    ),
  sourceKind: j
    .enum("ticket", "conversation")
    .describe("Intercom source kind."),
  sourceId: j.string().describe("Immutable Intercom API source ID."),
  jiraIssueId: j
    .string()
    .nullable()
    .describe("Immutable Jira issue ID after mapping."),
  jiraIssueKey: j
    .string()
    .nullable()
    .describe("Current Jira issue key after mapping."),
  jiraUrl: j
    .string()
    .nullable()
    .describe("Canonical Jira issue URL after mapping."),
  marker: j.string().describe("Deterministic provider reconciliation marker."),
  safeAttachmentCount: j
    .integer()
    .describe(
      "Count of safe attachment metadata entries copied; files and URLs are never copied."
    ),
  records: j.array(
    j.object({
      system: j.enum("notion", "intercom", "jira"),
      kind: j.enum("approval", "source", "issue", "receipt"),
      id: j.string(),
      url: j.string().nullable(),
      action: j.enum(
        "verified",
        "created",
        "enriched",
        "tagged",
        "routed",
        "noted",
        "receipt_written",
        "unchanged"
      ),
    }),
    { minItems: 1 }
  ),
  steps: j.array(
    j.object({
      name: j.enum(
        "approval",
        "source",
        "mapping",
        "jira",
        "intercom_tag",
        "intercom_route",
        "intercom_note",
        "receipt"
      ),
      state: j.enum("completed", "skipped", "blocked", "failed", "pending"),
    }),
    { minItems: 1 }
  ),
  warnings: j
    .array(j.string())
    .describe("Bounded policy warnings without raw provider content."),
  retryable: j
    .boolean()
    .describe("Whether the exact operation can be resumed safely."),
  retryAfterMs: j
    .integer()
    .nullable()
    .describe("Bounded provider-directed delay for a definite 429."),
  resumeToken: j
    .string()
    .nullable()
    .describe(
      "Exact operation ID for a safe resume after reconciliation or permission repair."
    ),
  repairInstruction: j
    .string()
    .nullable()
    .describe("Required operator action when automatic progress stops."),
  startedAt: j.datetime().describe("Durable operation creation time."),
  completedAt: j
    .datetime()
    .nullable()
    .describe("Verified completion time, stable across receipt retries."),
  message: j.string().describe("Concise completion or repair summary."),
})

worker.tool("escalateCustomerIssue", {
  title: "Escalate approved Intercom customer issue",
  description:
    "After a human approves one canonical packet in Notion, verify the exact Intercom ticket or conversation and account identity, atomically map it to one allowlisted Jira issue, create the issue or add one deterministic enrichment, add only an internal Intercom Jira-link note, apply and reread the configured tag/team route, then persist permanent Redis completion proof before the Notion receipt. Do not call to choose a destination, summarize a raw transcript, send a customer-visible reply, upload files, bulk escalate, or bypass stale approval/source checks. Inputs are limited to one source and one approval; ambiguous Jira and Intercom writes reconcile by fixed markers and are never blindly repeated.",
  schema: j.object({
    approvalPageId: j
      .uuid()
      .describe(
        "UUID of the Notion page containing the approved canonical packet."
      ),
    approvalRevision: j
      .string()
      .describe(
        "Exact 1–100 character stable revision stored on the approval page."
      ),
    approvalFingerprint: j
      .string()
      .describe(
        "Exactly 64 lowercase hexadecimal characters: SHA-256 of the canonical packet."
      ),
    sourceKind: j
      .enum("ticket", "conversation")
      .describe(
        "Exact approved Intercom resource kind; never infer it from a URL."
      ),
    sourceId: j
      .string()
      .describe(
        "Exact 1–100 character Intercom API ID, not an Inbox display number or URL."
      ),
  }),
  outputSchema: resultSchema,
  hints: { readOnlyHint: false },
  execute: async (input, { notion }) => {
    const config = loadConfig()
    const store = new RedisOperationStore({
      baseUrl: config.redisUrl,
      token: config.redisToken,
      timeoutMs: config.requestTimeoutMs,
    })
    return escalateCustomerIssue(input as EscalationInput, config, {
      notion: notion as unknown as NotionClientLike,
      store,
      intercom: new IntercomClient(config),
      jira: new JiraClient(config),
      now: () => new Date(),
      randomToken: randomUUID,
    })
  },
})
