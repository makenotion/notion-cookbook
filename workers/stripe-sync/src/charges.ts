// Stripe charges — individual payment attempts.
// Keep the schema and transform property order in sync.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"

import type { StripeCharge } from "./stripe.js"
import {
  amountToDecimal,
  dashboardUrl,
  formatEnumLabel,
  unixToISO,
} from "./helpers.js"

export const INITIAL_TITLE = "Stripe Charges"
export const PRIMARY_KEY = "Stripe Charge ID"

export const chargeSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("receipt"),
  properties: {
    Title: Schema.title(),

    Customer: Schema.richText(),

    Amount: Schema.number(),

    Currency: Schema.select([]),

    // Charge status is a fixed Stripe API enum, not workspace-defined.
    Status: Schema.select([
      { name: "Succeeded" },
      { name: "Pending" },
      { name: "Failed" },
    ]),

    Description: Schema.richText(),

    Refunded: Schema.checkbox(),

    "Amount Refunded": Schema.number(),

    "Failure Message": Schema.richText(),

    Date: Schema.date(),

    "Receipt Link": Schema.url(),

    "Charge Link": Schema.url(),

    "Stripe Charge ID": Schema.richText(),
  },
}

export function chargeToChange(charge: StripeCharge) {
  const description = charge.description?.trim()
  const title = description || `Charge ${charge.id}`
  const amount = amountToDecimal(charge.amount, charge.currency)
  const amountRefunded = amountToDecimal(
    charge.amount_refunded,
    charge.currency
  )
  const currency = charge.currency?.trim().toUpperCase()
  const status = formatEnumLabel(charge.status)
  const failureMessage = charge.failure_message?.trim()
  const receiptUrl = charge.receipt_url?.trim()
  const created = unixToISO(charge.created)

  return {
    // No upstreamUpdatedAt: `created` never changes even when `refunded` or
    // `status` change later, so it would be a misleading freshness watermark.
    // All three syncs in this worker run in replace mode, which diffs the
    // full snapshot each run instead of relying on one.
    type: "upsert" as const,
    key: charge.id,
    properties: {
      Title: Builder.title(title),
      ...(charge.customer
        ? { Customer: Builder.richText(charge.customer) }
        : {}),
      ...(amount != null ? { Amount: Builder.number(amount) } : {}),
      ...(currency ? { Currency: Builder.select(currency) } : {}),
      Status: Builder.select(status),
      ...(description ? { Description: Builder.richText(description) } : {}),
      Refunded: Builder.checkbox(Boolean(charge.refunded)),
      ...(amountRefunded != null
        ? { "Amount Refunded": Builder.number(amountRefunded) }
        : {}),
      ...(failureMessage
        ? { "Failure Message": Builder.richText(failureMessage) }
        : {}),
      ...(created ? { Date: Builder.dateTime(created) } : {}),
      ...(receiptUrl ? { "Receipt Link": Builder.url(receiptUrl) } : {}),
      "Charge Link": Builder.url(dashboardUrl(`charges/${charge.id}`)),
      "Stripe Charge ID": Builder.richText(charge.id),
    },
  }
}
