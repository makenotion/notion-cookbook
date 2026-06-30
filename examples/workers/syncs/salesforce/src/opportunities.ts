import { notionIcon } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

export const INITIAL_TITLE = "Salesforce Opportunities"
export const PRIMARY_KEY = "Opportunity ID"

export const OPPORTUNITY_FIELDS = [
  "Id",
  "IsDeleted",
  "Name",
  "StageName",
  "Amount",
  "Probability",
  "CloseDate",
  "Type",
  "LeadSource",
  "ForecastCategoryName",
  "IsClosed",
  "IsWon",
  "Owner.Name",
  "AccountId",
  "CreatedDate",
  "LastModifiedDate",
  "SystemModstamp",
  "Description",
] as const

export type SalesforceOpportunity = {
  Id: string
  IsDeleted: boolean
  Name: string
  StageName: string
  Amount: number | null
  Probability: number | null
  CloseDate: string
  Type: string | null
  LeadSource: string | null
  ForecastCategoryName: string | null
  IsClosed: boolean
  IsWon: boolean
  Owner: { Name: string | null } | null
  AccountId: string | null
  CreatedDate: string
  LastModifiedDate: string
  SystemModstamp: string
  Description: string | null
}

export const opportunitySchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("cash"),
  properties: {
    Name: Schema.title(),

    Stage: Schema.select([]),

    Amount: Schema.number(),

    Probability: Schema.number("percent"),

    "Close Date": Schema.date(),

    Type: Schema.select([]),

    "Lead Source": Schema.select([]),

    "Forecast Category": Schema.select([]),

    "Is Closed": Schema.checkbox(),

    "Is Won": Schema.checkbox(),

    Owner: Schema.richText(),

    Account: Schema.relation("accounts", {
      twoWay: true,
      relatedPropertyName: "Opportunities",
    }),

    Created: Schema.date(),

    Updated: Schema.date(),

    "Opportunity Link": Schema.url(),

    "Opportunity ID": Schema.richText(),
  },
}

export function opportunityToChange(
  opportunity: SalesforceOpportunity,
  instanceUrl: string
) {
  return {
    type: "upsert" as const,
    key: opportunity.Id,
    upstreamUpdatedAt: opportunity.SystemModstamp,
    pageContentMarkdown: opportunity.Description ?? "",
    properties: {
      Name: Builder.title(opportunity.Name),
      Stage: Builder.select(opportunity.StageName),
      ...(opportunity.Amount != null && Number.isFinite(opportunity.Amount)
        ? { Amount: Builder.number(opportunity.Amount) }
        : {}),
      ...(opportunity.Probability != null &&
      Number.isFinite(opportunity.Probability)
        ? { Probability: Builder.number(opportunity.Probability / 100) }
        : {}),
      "Close Date": Builder.date(opportunity.CloseDate),
      ...(opportunity.Type != null
        ? { Type: Builder.select(opportunity.Type) }
        : {}),
      ...(opportunity.LeadSource != null
        ? { "Lead Source": Builder.select(opportunity.LeadSource) }
        : {}),
      ...(opportunity.ForecastCategoryName != null
        ? {
            "Forecast Category": Builder.select(
              opportunity.ForecastCategoryName
            ),
          }
        : {}),
      "Is Closed": Builder.checkbox(opportunity.IsClosed),
      "Is Won": Builder.checkbox(opportunity.IsWon),
      ...(opportunity.Owner?.Name != null
        ? { Owner: Builder.richText(opportunity.Owner.Name) }
        : {}),
      Account: opportunity.AccountId
        ? [Builder.relation(opportunity.AccountId)]
        : [],
      Created: Builder.dateTime(opportunity.CreatedDate),
      Updated: Builder.dateTime(opportunity.LastModifiedDate),
      "Opportunity Link": Builder.url(
        lightningRecordUrl(instanceUrl, "Opportunity", opportunity.Id)
      ),
      "Opportunity ID": Builder.richText(opportunity.Id),
    },
  }
}

function lightningRecordUrl(
  instanceUrl: string,
  objectName: string,
  recordId: string
): string {
  const baseUrl = instanceUrl.replace(/\/+$/, "")
  return `${baseUrl}/lightning/r/${objectName}/${recordId}/view`
}
