// Stripe subscriptions — recurring billing status per customer.
// Keep the schema and transform property order in sync.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"

import { subscriptionPeriod, type StripeSubscription } from "./stripe.js"
import {
  amountToDecimal,
  dashboardUrl,
  formatEnumLabel,
  unixToISO,
} from "./helpers.js"

export const INITIAL_TITLE = "Stripe Subscriptions"
export const PRIMARY_KEY = "Stripe Subscription ID"

export const subscriptionSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("repeat"),
  properties: {
    Title: Schema.title(),

    Customer: Schema.richText(),

    // Subscription status is a fixed Stripe API enum, not workspace-defined.
    Status: Schema.select([
      { name: "Incomplete" },
      { name: "Incomplete Expired" },
      { name: "Trialing" },
      { name: "Active" },
      { name: "Past Due" },
      { name: "Canceled" },
      { name: "Unpaid" },
      { name: "Paused" },
    ]),

    Plan: Schema.richText(),

    Amount: Schema.number(),

    Currency: Schema.select([]),

    "Billing Interval": Schema.select([
      { name: "Day" },
      { name: "Week" },
      { name: "Month" },
      { name: "Year" },
    ]),

    Quantity: Schema.number(),

    "Current Period Start": Schema.date(),

    "Current Period End": Schema.date(),

    "Cancel At Period End": Schema.checkbox(),

    "Canceled At": Schema.date(),

    "Trial End": Schema.date(),

    "Subscription Link": Schema.url(),

    "Stripe Subscription ID": Schema.richText(),
  },
}

function intervalLabel(interval: string | undefined): string | null {
  if (!interval) return null
  return interval.charAt(0).toUpperCase() + interval.slice(1)
}

export function subscriptionToChange(subscription: StripeSubscription) {
  // A subscription can have multiple priced items, each billed independently.
  // This example surfaces the first item as the subscription's primary plan;
  // see the README's extension notes for multi-item subscriptions.
  const primaryItem = subscription.items.data[0]
  const price = primaryItem?.price

  const plan = price?.nickname?.trim() || price?.product || price?.id
  const title = plan || subscription.id
  const status = formatEnumLabel(subscription.status)
  const amount = amountToDecimal(price?.unit_amount, subscription.currency)
  const currency = subscription.currency?.trim().toUpperCase()
  const interval = intervalLabel(price?.recurring?.interval)
  const quantity = primaryItem?.quantity
  const period = subscriptionPeriod(subscription)
  const periodStart = unixToISO(period.start)
  const periodEnd = unixToISO(period.end)
  const canceledAt = unixToISO(subscription.canceled_at)
  const trialEnd = unixToISO(subscription.trial_end)

  return {
    type: "upsert" as const,
    key: subscription.id,
    properties: {
      Title: Builder.title(title),
      Customer: Builder.richText(subscription.customer),
      Status: Builder.select(status),
      ...(plan ? { Plan: Builder.richText(plan) } : {}),
      ...(amount != null ? { Amount: Builder.number(amount) } : {}),
      ...(currency ? { Currency: Builder.select(currency) } : {}),
      ...(interval ? { "Billing Interval": Builder.select(interval) } : {}),
      ...(quantity != null ? { Quantity: Builder.number(quantity) } : {}),
      ...(periodStart
        ? { "Current Period Start": Builder.dateTime(periodStart) }
        : {}),
      ...(periodEnd
        ? { "Current Period End": Builder.dateTime(periodEnd) }
        : {}),
      "Cancel At Period End": Builder.checkbox(
        Boolean(subscription.cancel_at_period_end)
      ),
      ...(canceledAt ? { "Canceled At": Builder.dateTime(canceledAt) } : {}),
      ...(trialEnd ? { "Trial End": Builder.dateTime(trialEnd) } : {}),
      "Subscription Link": Builder.url(
        dashboardUrl(`subscriptions/${subscription.id}`)
      ),
      "Stripe Subscription ID": Builder.richText(subscription.id),
    },
  }
}
