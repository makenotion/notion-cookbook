import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"
import type { HubSpotDeal, OwnerLookup } from "./hubspot.js"
import { ownerName } from "./hubspot.js"
import { dateOnly } from "./helpers.js"

export const INITIAL_TITLE = "HubSpot Deals"
export const PRIMARY_KEY = "Deal ID"

export const dealSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("currency"),
  properties: {
    "Deal Name": Schema.title(),

    Stage: Schema.select([]),

    Amount: Schema.number(),

    "Close Date": Schema.date(),

    Owner: Schema.richText(),

    "Deal Link": Schema.url(),

    Pipeline: Schema.richText(),

    "Deal Type": Schema.select([
      { name: "New Business" },
      { name: "Existing Business" },
    ]),

    Created: Schema.date(),

    "Deal ID": Schema.richText(),
  },
}

const DEAL_TYPE_LABELS: Record<string, string> = {
  newbusiness: "New Business",
  existingbusiness: "Existing Business",
}

export function dealToChange(
  id: string,
  deal: HubSpotDeal,
  updatedAt: string,
  portalId: string,
  owners: OwnerLookup
) {
  const owner = ownerName(owners, deal.hubspot_owner_id)
  const dealType = DEAL_TYPE_LABELS[deal.dealtype ?? ""]
  const amount = deal.amount ? Number(deal.amount) : null

  return {
    type: "upsert" as const,
    key: id,
    upstreamUpdatedAt: updatedAt,
    properties: {
      "Deal Name": Builder.title(deal.dealname ?? ""),
      ...(deal.dealstage
        ? { Stage: Builder.select(deal.dealstage) }
        : {}),
      ...(amount != null && !isNaN(amount)
        ? { Amount: Builder.number(amount) }
        : {}),
      ...(deal.closedate
        ? { "Close Date": Builder.date(dateOnly(deal.closedate)) }
        : {}),
      ...(owner ? { Owner: Builder.richText(owner) } : {}),
      "Deal Link": Builder.url(
        `https://app.hubspot.com/contacts/${portalId}/deal/${id}`
      ),
      ...(deal.pipeline
        ? { Pipeline: Builder.richText(deal.pipeline) }
        : {}),
      ...(dealType
        ? { "Deal Type": Builder.select(dealType) }
        : {}),
      ...(deal.createdate
        ? { Created: Builder.date(dateOnly(deal.createdate)) }
        : {}),
      "Deal ID": Builder.richText(id),
    },
  }
}
