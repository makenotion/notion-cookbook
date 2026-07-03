import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"

import { loadConfig } from "./config.js"
import { createNotionGateway } from "./notion.js"
import { recordMeetingOutcome } from "./orchestrator.js"
import { createSalesforceGateway } from "./salesforce.js"

const worker = new Worker()

export const recordMeetingOutcomeInputSchema = j.object({
  notionPageId: j
    .uuid()
    .describe(
      "UUID of the approved Notion meeting page. URLs are not accepted."
    ),
  approvedRevision: j
    .string()
    .describe(
      "Exact value in the page's configured Approved Revision property, at most 100 characters."
    ),
  approvalFingerprint: j
    .string()
    .describe(
      "Lowercase SHA-256 fingerprint from the page's Approved Fingerprint property. It must match the canonical tool payload."
    ),
  opportunityId: j
    .string()
    .describe(
      "Exact Salesforce Opportunity ID; names and URLs are not accepted."
    ),
  expectedOpportunityLastModifiedAt: j
    .datetime()
    .describe(
      "Opportunity LastModifiedDate captured in the approved packet. A mismatch blocks every write."
    ),
  meetingSubject: j
    .string()
    .describe("Approved activity subject, 1-255 plain-text characters."),
  occurredOn: j
    .date()
    .describe("Meeting date within the past 365 days, formatted YYYY-MM-DD."),
  outcomeSummary: j
    .string()
    .describe(
      "Approved outcome summary only, at most 4,000 characters. Never pass a raw transcript."
    ),
  primaryContactId: j
    .string()
    .nullable()
    .describe(
      "Optional Contact ID that must already be an Opportunity Contact Role."
    ),
  opportunityUpdates: j.object({
    nextStep: j
      .string()
      .nullable()
      .describe("Approved NextStep value, or null to leave it unchanged."),
    closeDate: j
      .date()
      .nullable()
      .describe("Approved CloseDate, or null to leave it unchanged."),
    stageName: j
      .string()
      .nullable()
      .describe(
        "Explicitly approved StageName, or null. The current-to-target transition must be configured in the Worker allowlist."
      ),
  }),
  followUps: j
    .array(
      j.object({
        subject: j
          .string()
          .describe("Approved follow-up subject, 1-255 characters."),
        description: j
          .string()
          .nullable()
          .describe("Optional approved detail, at most 1,000 characters."),
        dueDate: j.date().describe("Due date within the next 180 days."),
        ownerId: j.string().describe("Active, allowlisted Salesforce User ID."),
        contactId: j
          .string()
          .nullable()
          .describe(
            "Optional Contact ID that must already be an Opportunity Contact Role."
          ),
      })
    )
    .describe("Zero to five approved, owned follow-up Tasks."),
})

const recordSchema = j.object({
  system: j.enum("salesforce", "notion"),
  kind: j.string(),
  id: j.string(),
  url: j.string().nullable(),
  action: j.enum("created", "updated", "verified", "written", "unchanged"),
})

const stepSchema = j.object({
  name: j.string(),
  status: j.enum("completed", "skipped", "failed"),
  detail: j.string().nullable(),
})

export const recordMeetingOutcomeOutputSchema = j.object({
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
  inputFingerprint: j.string(),
  changed: j.boolean(),
  replay: j.boolean(),
  records: j.array(recordSchema),
  changedFields: j.array(j.string()),
  steps: j.array(stepSchema),
  warnings: j.array(j.string()),
  retryable: j.boolean(),
  resumeToken: j.string().nullable(),
  repairInstruction: j.string().nullable(),
})

worker.tool("recordMeetingOutcome", {
  title: "Record approved Salesforce meeting outcome",
  description:
    "After a human approves a fingerprinted meeting-outcome packet on one Notion page, record it as one completed Salesforce Task, apply only explicit NextStep/CloseDate/allowlisted StageName changes, create at most five allowlisted-owner follow-up Tasks, and write back a canonical receipt. Do not call for transcript summarization, unapproved or stale packets, uncertain Opportunity identity, arbitrary CRM fields, bulk updates, or corrections to an already completed meeting log. The Worker re-reads Notion and Salesforce, uses a provider-unique durable claim plus an all-or-none Salesforce Composite transaction, and returns replay-safe completed, no_op, blocked, conflict, partial_failure, or ambiguous receipts.",
  schema: recordMeetingOutcomeInputSchema,
  outputSchema: recordMeetingOutcomeOutputSchema,
  hints: { readOnlyHint: false },
  execute: async (input, { notion }) => {
    const config = loadConfig()
    return recordMeetingOutcome(input, {
      notion: createNotionGateway(notion, config),
      salesforce: createSalesforceGateway(config),
      policy: config,
    })
  },
})

export default worker
