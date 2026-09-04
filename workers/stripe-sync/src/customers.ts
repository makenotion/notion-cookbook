// Stripe customers — who a subscription or charge belongs to.
// Keep the schema and transform property order in sync.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"

import type { StripeCustomer } from "./stripe.js"
import {
  amountToDecimal,
  dashboardUrl,
  formatAddress,
  unixToISO,
} from "./helpers.js"

export const INITIAL_TITLE = "Stripe Customers"
export const PRIMARY_KEY = "Stripe Customer ID"

export const customerSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("profile"),
  properties: {
    Name: Schema.title(),

    Email: Schema.email(),

    Balance: Schema.number(),

    // ISO currency codes are numerous and not workspace-specific, so options
    // are created dynamically as new currencies are seen.
    Currency: Schema.select([]),

    Delinquent: Schema.checkbox(),

    Address: Schema.richText(),

    Description: Schema.richText(),

    "Customer Link": Schema.url(),

    Created: Schema.date(),

    "Stripe Customer ID": Schema.richText(),
  },
}

export function customerToChange(customer: StripeCustomer) {
  const name = customer.name?.trim() || customer.email?.trim() || customer.id
  const email = customer.email?.trim()
  const balance = amountToDecimal(customer.balance, customer.currency)
  const currency = customer.currency?.trim().toUpperCase()
  const address = formatAddress(customer.address)
  const description = customer.description?.trim()
  const created = unixToISO(customer.created)

  return {
    type: "upsert" as const,
    key: customer.id,
    pageContentMarkdown: description ?? "",
    properties: {
      Name: Builder.title(name),
      ...(email ? { Email: Builder.email(email) } : {}),
      ...(balance != null ? { Balance: Builder.number(balance) } : {}),
      ...(currency ? { Currency: Builder.select(currency) } : {}),
      Delinquent: Builder.checkbox(Boolean(customer.delinquent)),
      ...(address ? { Address: Builder.richText(address) } : {}),
      ...(description ? { Description: Builder.richText(description) } : {}),
      "Customer Link": Builder.url(dashboardUrl(`customers/${customer.id}`)),
      ...(created ? { Created: Builder.dateTime(created) } : {}),
      "Stripe Customer ID": Builder.richText(customer.id),
    },
  }
}
