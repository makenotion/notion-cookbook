import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"
import type { HubSpotDeal, OwnerLookup, PipelineLookup } from "./hubspot.js"
import { ownerName } from "./hubspot.js"
import { dateOnly } from "./helpers.js"

export const INITIAL_TITLE = "HubSpot Deals"
export const PRIMARY_KEY = "Deal ID"

export const dealSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("cash"),
  properties: {
    "Deal Name": Schema.title(),

    Stage: Schema.select([]),

    Amount: Schema.number(),

    "Close Date": Schema.date(),

    Pipeline: Schema.richText(),

    Owner: Schema.richText(),

    Company: Schema.relation("companies"),

    Contact: Schema.relation("contacts"),

    "Forecast Amount": Schema.number(),

    "Forecast Category": Schema.select([]),

    "Closed Won": Schema.checkbox(),

    "Deal Type": Schema.select([
      { name: "New Business" },
      { name: "Existing Business" },
    ]),

    Updated: Schema.date(),

    Created: Schema.date(),

    "Deal Link": Schema.url(),

    "Stage ID": Schema.richText(),

    "Pipeline ID": Schema.richText(),

    "Deal ID": Schema.richText(),
  },
}

const DEAL_TYPE_LABELS: Record<string, string> = {
  newbusiness: "New Business",
  existingbusiness: "Existing Business",
}

export type DealContext = {
  portalId: string
  owners: OwnerLookup
  pipelines: PipelineLookup
}

export function dealToChange(
  id: string,
  deal: HubSpotDeal,
  updatedAt: string,
  associations: Record<string, string[]>,
  ctx: DealContext
) {
  const owner = ownerName(ctx.owners, deal.hubspot_owner_id)
  const dealTypeValue = deal.dealtype?.trim()
  const dealType = dealTypeValue
    ? DEAL_TYPE_LABELS[dealTypeValue] ?? dealTypeValue
    : null
  const amount = deal.amount ? Number(deal.amount) : null
  const forecastAmount = deal.hs_forecast_amount
    ? Number(deal.hs_forecast_amount)
    : null
  const closedWon = deal.hs_is_closed_won === "true"

  const stageName = ctx.pipelines.stageName(deal.dealstage ?? "")
  const pipelineName = ctx.pipelines.pipelineName(deal.pipeline ?? "")

  const companyIds = [...new Set(associations["companies"] ?? [])]
  const contactIds = [...new Set(associations["contacts"] ?? [])]

  return {
    type: "upsert" as const,
    key: id,
    upstreamUpdatedAt: updatedAt,
    pageContentMarkdown: deal.description ?? "",
    properties: {
      "Deal Name": Builder.title(deal.dealname ?? ""),
      ...(stageName
        ? { Stage: Builder.select(stageName) }
        : deal.dealstage
          ? { Stage: Builder.select(deal.dealstage) }
          : {}),
      ...(amount != null && !isNaN(amount)
        ? { Amount: Builder.number(amount) }
        : {}),
      ...(deal.closedate
        ? { "Close Date": Builder.date(dateOnly(deal.closedate)) }
        : {}),
      ...(pipelineName
        ? { Pipeline: Builder.richText(pipelineName) }
        : deal.pipeline
          ? { Pipeline: Builder.richText(deal.pipeline) }
          : {}),
      ...(owner ? { Owner: Builder.richText(owner) } : {}),
      Company: companyIds.map((companyId) => Builder.relation(companyId)),
      Contact: contactIds.map((contactId) => Builder.relation(contactId)),
      ...(forecastAmount != null && !isNaN(forecastAmount)
        ? { "Forecast Amount": Builder.number(forecastAmount) }
        : {}),
      ...(deal.hs_forecast_category
        ? { "Forecast Category": Builder.select(deal.hs_forecast_category) }
        : {}),
      "Closed Won": Builder.checkbox(closedWon),
      ...(dealType ? { "Deal Type": Builder.select(dealType) } : {}),
      Updated: Builder.date(dateOnly(updatedAt)),
      ...(deal.createdate
        ? { Created: Builder.date(dateOnly(deal.createdate)) }
        : {}),
      "Deal Link": Builder.url(
        `https://app.hubspot.com/contacts/${ctx.portalId}/deal/${id}`
      ),
      ...(deal.dealstage
        ? { "Stage ID": Builder.richText(deal.dealstage) }
        : {}),
      ...(deal.pipeline
        ? { "Pipeline ID": Builder.richText(deal.pipeline) }
        : {}),
      "Deal ID": Builder.richText(id),
    },
  }
}
