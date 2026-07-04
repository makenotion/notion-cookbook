import { j } from "@notionhq/workers/schema-builder"

const nodeSchema = j.object({
  nodeKey: j.string().describe("Stable lowercase key unique within this plan."),
  issueTypeId: j.string().describe("Allowlisted Jira issue type ID."),
  parentNodeKey: j
    .string()
    .nullable()
    .describe("Parent node key, or null for a root; maximum depth is two."),
  summary: j
    .string()
    .describe("Approved Jira summary; at most 180 UTF-8 bytes."),
  description: j
    .string()
    .describe("Approved plain-text description; at most 4,000 UTF-8 bytes."),
  assigneeAccountId: j
    .string()
    .nullable()
    .describe("Allowlisted Jira account ID, or null."),
  labels: j
    .array(j.string())
    .describe("Zero to ten allowlisted Jira labels; complete desired value."),
  estimatePoints: j
    .integer()
    .nullable()
    .describe("Allowlisted estimate field value from 0 to 100, or null."),
  sprintId: j
    .integer()
    .nullable()
    .describe("Allowlisted Jira sprint ID, or null."),
  fixVersionId: j
    .string()
    .nullable()
    .describe("Allowlisted Jira fix-version ID, or null."),
})

export const publishImplementationPlanSchema = j.object({
  approvalPageId: j
    .string()
    .describe("UUID of the approved Notion implementation-plan page."),
  approvalRevision: j
    .string()
    .describe("Exact explicit revision stored on the Notion approval page."),
  planHash: j
    .string()
    .describe("Lowercase SHA-256 of the complete canonical plan."),
  projectKey: j
    .string()
    .describe("One Jira project key present in the configured allowlist."),
  nodes: j
    .array(nodeSchema, { minItems: 1 })
    .describe("Complete hierarchy of one to fifteen approved nodes."),
  dependencies: j
    .array(
      j.object({
        blockerNodeKey: j.string(),
        blockedNodeKey: j.string(),
      })
    )
    .describe("Complete acyclic dependency set; at most thirty edges."),
})

const nodeRecordSchema = j.object({
  nodeKey: j.string(),
  issueId: j.string().nullable(),
  issueKey: j.string().nullable(),
  url: j.string().nullable(),
  action: j.enum("created", "existing", "failed", "unknown"),
})

const dependencyRecordSchema = j.object({
  blockerNodeKey: j.string(),
  blockedNodeKey: j.string(),
  action: j.enum("created", "existing", "failed", "unknown"),
})

const stepSchema = j.object({
  name: j.enum(
    "approval",
    "claim",
    "metadata",
    "nodes",
    "dependencies",
    "notion_receipt"
  ),
  status: j.enum("completed", "skipped", "failed", "unknown"),
  detail: j.string(),
})

export const publishImplementationPlanReceiptSchema = j.object({
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
  projectKey: j.string(),
  planHash: j.string(),
  approvalPageId: j.string(),
  approvalRevision: j.string(),
  providerPolicyFingerprint: j.string(),
  startedAt: j.string(),
  completedAt: j.string().nullable(),
  nodes: j.array(nodeRecordSchema),
  dependencies: j.array(dependencyRecordSchema),
  notionReceiptWritten: j.boolean(),
  steps: j.array(stepSchema),
  warnings: j.array(j.string()),
  retryable: j.boolean(),
  retryAfterSeconds: j.integer().nullable(),
  repair: j.string().nullable(),
})
