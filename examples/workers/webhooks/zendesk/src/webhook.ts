import { WebhookVerificationError, type Worker } from "@notionhq/workers"
import { getNotionDatabaseId, upsertZendeskTicket } from "./notion.js"
import { parseZendeskTicket } from "./parse-ticket.js"
import {
  getZendeskWebhookSecret,
  verifyZendeskWebhookSignature,
} from "./zendesk/config.js"
import { enrichTicketWithComments } from "./zendesk/comments.js"

function formatBody(body: unknown): string {
  if (typeof body === "string") return body
  try {
    return JSON.stringify(body, null, 2)
  } catch {
    return String(body)
  }
}

export function registerZendeskToNotionWebhook(worker: Worker): void {
  worker.webhook("zendeskToNotion", {
    title: "Zendesk to Notion",
    description:
      "Verifies Zendesk webhook signatures and upserts ticket rows into a Notion database.",
    execute: async (events, { notion }) => {
      const secret = getZendeskWebhookSecret()
      const databaseId = getNotionDatabaseId()

      for (const event of events) {
        const valid = verifyZendeskWebhookSignature(
          event.rawBody,
          event.headers,
          secret
        )
        if (!valid) {
          throw new WebhookVerificationError(
            "Invalid Zendesk webhook signature (check ZENDESK_WEBHOOK_SECRET and use the signing secret for this webhook)."
          )
        }

        const ticket = parseZendeskTicket(event.body)
        if (!ticket) {
          console.log(
            "[zendeskToNotion] No ticket fields in body; logging for inspection:",
            formatBody(event.body)
          )
          continue
        }

        const ticketToUpsert = await enrichTicketWithComments(
          ticket,
          "zendeskToNotion"
        )

        const result = await upsertZendeskTicket(
          notion,
          databaseId,
          ticketToUpsert
        )
        console.log(
          `[zendeskToNotion] ${result.action} Notion page ${result.pageId} for ticket ${ticket.ticketId}`
        )
      }
    },
  })
}
