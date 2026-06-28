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

    Type: Schema.select([
      { name: "Prospect" },
      { name: "Partner" },
      { name: "Reseller" },
      { name: "Vendor" },
      { name: "Customer" },
    ]),

    City: Schema.richText(),

    Country: Schema.richText(),

    Phone: Schema.richText(),

    Created: Schema.date(),

    "Company Link": Schema.url(),

    "Company ID": Schema.richText(),
  },
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
  const companyType = TYPE_LABELS[company.type?.toUpperCase() ?? ""]
  const employees = company.numberofemployees
    ? Number(company.numberofemployees)
    : null
  const revenue = company.annualrevenue
    ? Number(company.annualrevenue)
    : null

  return {
    type: "upsert" as const,
    key: id,
    upstreamUpdatedAt: updatedAt,
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
      ...(companyType ? { Type: Builder.select(companyType) } : {}),
      ...(company.city
        ? { City: Builder.richText(company.city) }
        : {}),
      ...(company.country
        ? { Country: Builder.richText(company.country) }
        : {}),
      ...(company.phone
        ? { Phone: Builder.richText(company.phone) }
        : {}),
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
