import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"
import type { HubSpotCompany, OwnerLookup } from "./hubspot.js"
import { ownerName } from "./hubspot.js"
import { dateOnly } from "./helpers.js"

export const INITIAL_TITLE = "HubSpot Companies"
export const PRIMARY_KEY = "Company ID"

export const companySchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("briefcase"),
  properties: {
    Name: Schema.title(),

    Industry: Schema.select([]),

    Domain: Schema.url(),

    "Annual Revenue": Schema.number(),

    "Number of Employees": Schema.number(),

    Owner: Schema.richText(),

    "Open Deals": Schema.number(),

    "Total Revenue": Schema.number(),

    "Lifecycle Stage": Schema.select([
      { name: "Subscriber" },
      { name: "Lead" },
      { name: "Marketing Qualified Lead" },
      { name: "Sales Qualified Lead" },
      { name: "Opportunity" },
      { name: "Customer" },
      { name: "Evangelist" },
      { name: "Other" },
    ]),

    Type: Schema.select([
      { name: "Prospect" },
      { name: "Partner" },
      { name: "Reseller" },
      { name: "Vendor" },
      { name: "Customer" },
    ]),

    City: Schema.richText(),

    Country: Schema.richText(),

    Phone: Schema.phoneNumber(),

    Updated: Schema.date(),

    Created: Schema.date(),

    "Company Link": Schema.url(),

    "Company ID": Schema.richText(),
  },
}

const LIFECYCLE_LABELS: Record<string, string> = {
  subscriber: "Subscriber",
  lead: "Lead",
  marketingqualifiedlead: "Marketing Qualified Lead",
  salesqualifiedlead: "Sales Qualified Lead",
  opportunity: "Opportunity",
  customer: "Customer",
  evangelist: "Evangelist",
  other: "Other",
}

const TYPE_LABELS: Record<string, string> = {
  PROSPECT: "Prospect",
  PARTNER: "Partner",
  RESELLER: "Reseller",
  VENDOR: "Vendor",
  CUSTOMER: "Customer",
}

export function companyToChange(
  id: string,
  company: HubSpotCompany,
  updatedAt: string,
  portalId: string,
  owners: OwnerLookup
) {
  const owner = ownerName(owners, company.hubspot_owner_id)
  const companyTypeValue = company.type?.trim()
  const lifecycleValue = company.lifecyclestage?.trim()
  const companyType = companyTypeValue
    ? (TYPE_LABELS[companyTypeValue.toUpperCase()] ?? companyTypeValue)
    : null
  const lifecycle = lifecycleValue
    ? (LIFECYCLE_LABELS[lifecycleValue] ?? lifecycleValue)
    : null
  const employees = company.numberofemployees
    ? Number(company.numberofemployees)
    : null
  const revenue = company.annualrevenue ? Number(company.annualrevenue) : null
  const openDeals = company.hs_num_open_deals
    ? Number(company.hs_num_open_deals)
    : null
  const totalRevenue = company.total_revenue
    ? Number(company.total_revenue)
    : null

  return {
    type: "upsert" as const,
    key: id,
    upstreamUpdatedAt: updatedAt,
    pageContentMarkdown: company.description ?? "",
    properties: {
      Name: Builder.title(company.name ?? ""),
      ...(company.industry
        ? { Industry: Builder.select(company.industry) }
        : {}),
      ...(company.domain
        ? { Domain: Builder.url(`https://${company.domain}`) }
        : {}),
      ...(revenue != null && !isNaN(revenue)
        ? { "Annual Revenue": Builder.number(revenue) }
        : {}),
      ...(employees != null && !isNaN(employees)
        ? { "Number of Employees": Builder.number(employees) }
        : {}),
      ...(owner ? { Owner: Builder.richText(owner) } : {}),
      ...(openDeals != null && !isNaN(openDeals)
        ? { "Open Deals": Builder.number(openDeals) }
        : {}),
      ...(totalRevenue != null && !isNaN(totalRevenue)
        ? { "Total Revenue": Builder.number(totalRevenue) }
        : {}),
      ...(lifecycle ? { "Lifecycle Stage": Builder.select(lifecycle) } : {}),
      ...(companyType ? { Type: Builder.select(companyType) } : {}),
      ...(company.city ? { City: Builder.richText(company.city) } : {}),
      ...(company.country
        ? { Country: Builder.richText(company.country) }
        : {}),
      ...(company.phone ? { Phone: Builder.phoneNumber(company.phone) } : {}),
      Updated: Builder.date(dateOnly(updatedAt)),
      ...(company.createdate
        ? { Created: Builder.date(dateOnly(company.createdate)) }
        : {}),
      "Company Link": Builder.url(
        `https://app.hubspot.com/contacts/${portalId}/company/${id}`
      ),
      "Company ID": Builder.richText(id),
    },
  }
}
