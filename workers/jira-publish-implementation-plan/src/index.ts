import { Worker } from "@notionhq/workers"

import { loadConfig } from "./config.js"
import { JiraClient } from "./jira.js"
import { RedisOperationLedger } from "./ledger.js"
import { NotionPlanStore, type NotionClientLike } from "./notion.js"
import { PublishImplementationPlanOrchestrator } from "./orchestrator.js"
import {
  publishImplementationPlanReceiptSchema,
  publishImplementationPlanSchema,
} from "./schemas.js"

const worker = new Worker()
export default worker

worker.tool("publishImplementationPlan", {
  title: "Publish approved Jira implementation plan",
  description:
    "Publish one complete, explicitly approved Notion work breakdown as a replay-safe Jira hierarchy with dependencies and backlinks, then write the canonical mapping to Notion. Call only with the exact approved revision and canonical hash for one allowlisted project, 1-15 complete nodes, maximum hierarchy depth two, and at most 30 dependency edges. Do not call to explore Jira, create an individual issue, infer approval, silently omit fields, update a previously published plan, or repair manual Jira edits. Revalidates current Jira metadata and Notion authority before writes; ambiguous writes are reconciled by deterministic markers and are never blindly retried.",
  schema: publishImplementationPlanSchema,
  outputSchema: publishImplementationPlanReceiptSchema,
  hints: { readOnlyHint: false },
  execute: async (input, { notion }) => {
    const config = loadConfig()
    return new PublishImplementationPlanOrchestrator({
      config,
      jira: new JiraClient(config),
      ledger: new RedisOperationLedger({
        url: config.redisUrl,
        token: config.redisToken,
        requestTimeoutMs: config.redisRequestTimeoutMs,
        leaseTtlMs: config.leaseTtlMs,
      }),
      notion: new NotionPlanStore(
        notion as unknown as NotionClientLike,
        config
      ),
    }).execute(input)
  },
})
