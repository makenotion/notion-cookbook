/**
 * This example shows how to verify GitHub webhook signatures using
 * HMAC-SHA256. Set GITHUB_WEBHOOK_SECRET via `ntn workers env set`.
 *
 * After 5 consecutive WebhookVerificationError throws, the platform
 * short-circuits and rejects all incoming requests without executing
 * the handler. Redeploying the worker resets the counter.
 */

import crypto from "crypto"
import { Worker, WebhookVerificationError } from "@notionhq/workers"

const worker = new Worker()
export default worker

/**
 * Verify a GitHub webhook signature.
 * GitHub sends the HMAC-SHA256 signature in the X-Hub-Signature-256 header
 * as "sha256={hex}". The raw body must be used for verification.
 */
function verifyGitHubSignature(
  rawBody: string,
  headers: Record<string, string>
): void {
  const secret = process.env.GITHUB_WEBHOOK_SECRET
  if (!secret) {
    throw new WebhookVerificationError("GITHUB_WEBHOOK_SECRET not configured")
  }

  const signature = headers["x-hub-signature-256"]
  if (!signature?.startsWith("sha256=")) {
    throw new WebhookVerificationError("Invalid GitHub signature")
  }

  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")}`

  if (signature.length !== expected.length) {
    throw new WebhookVerificationError("Invalid GitHub signature")
  }

  // Use timing-safe comparison to prevent timing attacks
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new WebhookVerificationError("Invalid GitHub signature")
  }
}

worker.webhook("onGithubPush", {
  title: "GitHub Push Webhook",
  description: "Handles push events from GitHub repositories",
  execute: async (events) => {
    for (const event of events) {
      verifyGitHubSignature(event.rawBody, event.headers)

      // Signature verified — safe to process
      const body = event.body
      const ref = body.ref as string | undefined
      const pusher = body.pusher as { name?: string } | undefined
      console.log(
        `Verified push to ${ref ?? "unknown"} by ${pusher?.name ?? "unknown"}`
      )
    }
  },
})
