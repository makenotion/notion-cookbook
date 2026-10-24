import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

export const INITIAL_TITLE = "Salesforce Accounts"
export const PRIMARY_KEY = "Account ID"

export const ACCOUNT_FIELDS = [
  "Id",
  "IsDeleted",
  "Name",
  "Industry",
  "Type",
  "Website",
  "Phone",
  "BillingCity",
  "BillingCountry",
  "AnnualRevenue",
  "NumberOfEmployees",
  "Owner.Name",
  "CreatedDate",
  "LastModifiedDate",
  "SystemModstamp",
  "Description",
] as const

export type SalesforceAccount = {
  Id: string
  IsDeleted: boolean
  Name: string
  Industry: string | null
  Type: string | null
  Website: string | null
  Phone: string | null
  BillingCity: string | null
  BillingCountry: string | null
  AnnualRevenue: number | null
  NumberOfEmployees: number | null
  Owner: { Name: string | null } | null
  CreatedDate: string
  LastModifiedDate: string
  SystemModstamp: string
  Description: string | null
}

export const accountSchema = {
  databaseIcon: notionIcon("briefcase"),
  properties: {
    Name: Schema.title(),

    Industry: Schema.select([]),

    Type: Schema.select([]),

    Website: Schema.url(),

    Phone: Schema.phoneNumber(),

    "Billing City": Schema.richText(),

    "Billing Country": Schema.richText(),

    "Annual Revenue": Schema.number(),

    Employees: Schema.number(),

    Owner: Schema.richText(),

    Created: Schema.date(),

    Updated: Schema.date(),

    "Account Link": Schema.url(),

    "Account ID": Schema.richText(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

export function accountToChange(
  account: SalesforceAccount,
  instanceUrl: string
): SyncChangeUpsert<typeof PRIMARY_KEY, typeof accountSchema.properties> {
  const website = normalizeWebsite(account.Website)

  return {
    type: "upsert" as const,
    key: account.Id,
    upstreamUpdatedAt: account.SystemModstamp,
    pageContentMarkdown: account.Description ?? "",
    properties: {
      Name: Builder.title(account.Name),
      Industry:
        account.Industry != null ? Builder.select(account.Industry) : [],
      Type: account.Type != null ? Builder.select(account.Type) : [],
      Website: website ? Builder.url(website) : [],
      Phone: account.Phone != null ? Builder.phoneNumber(account.Phone) : [],
      "Billing City":
        account.BillingCity != null
          ? Builder.richText(account.BillingCity)
          : [],
      "Billing Country":
        account.BillingCountry != null
          ? Builder.richText(account.BillingCountry)
          : [],
      "Annual Revenue":
        account.AnnualRevenue != null && Number.isFinite(account.AnnualRevenue)
          ? Builder.number(account.AnnualRevenue)
          : [],
      Employees:
        account.NumberOfEmployees != null &&
        Number.isFinite(account.NumberOfEmployees)
          ? Builder.number(account.NumberOfEmployees)
          : [],
      Owner:
        account.Owner?.Name != null ? Builder.richText(account.Owner.Name) : [],
      Created: Builder.dateTime(account.CreatedDate),
      Updated: Builder.dateTime(account.LastModifiedDate),
      "Account Link": Builder.url(
        lightningRecordUrl(instanceUrl, "Account", account.Id)
      ),
      "Account ID": Builder.richText(account.Id),
    },
  }
}

function normalizeWebsite(value: string | null): string | undefined {
  const website = value?.trim()
  if (!website) return undefined

  const candidate = /^[a-z][a-z\d+.-]*:/i.test(website)
    ? website
    : `https://${website}`
  try {
    const url = new URL(candidate)
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined
  } catch {
    return undefined
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
