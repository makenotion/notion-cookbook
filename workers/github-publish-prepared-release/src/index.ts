import { Worker } from "@notionhq/workers"

import { createGitHubAccessTokenProvider } from "./auth.js"
import { loadConfig } from "./config.js"
import { GitHubClient } from "./github.js"
import { RedisOperationLedger } from "./ledger.js"
import { NotionPacketStore, type NotionClientLike } from "./notion.js"
import { PublishPreparedReleaseOrchestrator } from "./orchestrator.js"
import {
  publishPreparedReleaseSchema,
  publishReceiptSchema,
} from "./schemas.js"

const worker = new Worker()
export default worker

const getAccessToken = createGitHubAccessTokenProvider()

worker.tool("publishPreparedRelease", {
  title: "Publish approved GitHub release",
  description:
    "Publish one exact, already-approved GitHub draft release and write its receipt to the approved Notion packet. Call only after a human approved the supplied revision and canonical fingerprint, with an existing allowlisted tag, exact commit, 1-20 successful gates, and at most 100 exact assets. Do not call to draft, edit, explore, retarget, generate notes, bypass checks, or publish an unapproved release. Revalidates everything immediately before the write, never retries PATCH, reconciles ambiguity, and safely resumes receipt-only failures.",
  schema: publishPreparedReleaseSchema,
  outputSchema: publishReceiptSchema,
  hints: { readOnlyHint: false },
  execute: async (input, { notion }) => {
    const config = loadConfig()
    const orchestrator = new PublishPreparedReleaseOrchestrator({
      config,
      github: new GitHubClient({
        getAccessToken,
        requestTimeoutMs: config.githubRequestTimeoutMs,
      }),
      ledger: new RedisOperationLedger({
        url: config.redisUrl,
        token: config.redisToken,
        requestTimeoutMs: config.redisRequestTimeoutMs,
        leaseTtlMs: config.leaseTtlMs,
      }),
      notion: new NotionPacketStore(
        notion as unknown as NotionClientLike,
        config
      ),
    })
    return orchestrator.execute(input)
  },
})
