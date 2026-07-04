import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"
import { loadConfig } from "./config.js"
import { executeApprovedTransition } from "./transition.js"
import type {
  NotionClientLike,
  TransitionAction,
  TransitionInput,
} from "./types.js"
import { VercelClient } from "./vercel.js"

const worker = new Worker()
export default worker

const inputSchema = j.object({
  approvalPageId: j
    .uuid()
    .describe("Notion page in the configured Vercel approvals database."),
})

const outputSchema = j.object({
  ok: j.boolean().describe("Whether the approved transition is complete."),
  status: j
    .enum("completed", "no_op", "blocked", "conflict", "ambiguous")
    .describe("Current outcome of the approved transition."),
  action: j.enum("promote", "rollback").describe("Approved release action."),
  operationId: j.string().describe("Stable ID for this approved transition."),
  changed: j
    .boolean()
    .describe(
      "Whether this call attempted a Vercel request and then observed the target in production; it does not prove exclusive causality."
    ),
  requestAttempted: j
    .boolean()
    .describe("Whether this call attempted a Vercel traffic request."),
  receiptState: j
    .enum("none", "request_started", "completed", "rejected", "cancelled")
    .describe(
      "Last canonical Worker receipt state confirmed from the approval page."
    ),
  targetDeploymentId: j
    .string()
    .nullable()
    .describe("Deployment selected by the approval page, when available."),
  currentDeploymentId: j
    .string()
    .nullable()
    .describe("Deployment currently observed across production domains."),
  retryable: j
    .boolean()
    .describe("Whether the same approval page can be checked again safely."),
  nextStep: j
    .string()
    .nullable()
    .describe("Required follow-up, or null when no action remains."),
  message: j.string().describe("Concise outcome for the user."),
})

async function execute(
  action: TransitionAction,
  input: TransitionInput,
  notion: NotionClientLike
) {
  const config = loadConfig()
  const vercel = new VercelClient({
    token: config.vercelToken,
    protectionBypassSecret: config.protectionBypassSecret,
  })
  return executeApprovedTransition(action, input, config, {
    notion,
    vercel,
    now: () => new Date(),
    sleep: (milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  })
}

worker.tool("promoteApprovedDeployment", {
  title: "Promote an approved Vercel deployment",
  description:
    "Promote the exact Vercel deployment on an approved Notion page. The Worker rechecks the approval, project, Git SHA, deployment checks, rolling-release state, production owner, and fixed health endpoints before changing traffic. This basic recipe requires one caller and an unchanged approval page per transition; never clear its Worker receipt.",
  schema: inputSchema,
  outputSchema,
  hints: { readOnlyHint: false },
  execute: (input, { notion }) =>
    execute(
      "promote",
      input as TransitionInput,
      notion as unknown as NotionClientLike
    ),
})

worker.tool("rollbackApprovedDeployment", {
  title: "Roll back to an approved Vercel deployment",
  description:
    "Restore the exact Vercel deployment on an approved Notion page. The Worker applies the same project, Git SHA, rolling-release, production-owner, and health checks used for promotion. It reuses an existing deployment; it does not rebuild with current environment variables. This basic recipe requires one caller and an unchanged approval page per transition; never clear its Worker receipt.",
  schema: inputSchema,
  outputSchema,
  hints: { readOnlyHint: false },
  execute: (input, { notion }) =>
    execute(
      "rollback",
      input as TransitionInput,
      notion as unknown as NotionClientLike
    ),
})
