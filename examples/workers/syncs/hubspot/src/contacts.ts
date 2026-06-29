import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"
import type { HubSpotContact, OwnerLookup } from "./hubspot.js"
import { ownerName } from "./hubspot.js"
import { dateOnly } from "./helpers.js"

export const INITIAL_TITLE = "HubSpot Contacts"
export const PRIMARY_KEY = "Contact ID"

export const contactSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("people"),
  properties: {
    Name: Schema.title(),

    "Lifecycle Stage": Schema.select([
      { name: "Subscriber" },
      { name: "Lead" },
      { name: "Marketing Qualified Lead" },
      { name: "Sales Qualified Lead" },
      { name: "Opportunity" },
      { name: "Customer" },
      { name: "Evangelist" },
    ]),

    "Lead Status": Schema.select([
      { name: "New" },
      { name: "Open" },
      { name: "In Progress" },
      { name: "Unqualified" },
    ]),

    Email: Schema.email(),

    Company: Schema.richText(),

    "Last Activity": Schema.date(),

    "Job Title": Schema.richText(),

    Owner: Schema.richText(),

    Phone: Schema.richText(),

    "Associated Deals": Schema.number(),

    "Recent Deal Amount": Schema.number(),

    Updated: Schema.date(),

    Created: Schema.date(),

    "Contact Link": Schema.url(),

    "Contact ID": Schema.richText(),
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
}

const LEAD_STATUS_LABELS: Record<string, string> = {
  NEW: "New",
  OPEN: "Open",
  IN_PROGRESS: "In Progress",
  UNQUALIFIED: "Unqualified",
}

function contactName(contact: HubSpotContact): string {
  const parts = [contact.firstname, contact.lastname].filter(Boolean)
  return parts.join(" ") || "(no name)"
}

export function contactToChange(
  id: string,
  contact: HubSpotContact,
  updatedAt: string,
  portalId: string,
  owners: OwnerLookup
) {
  const lifecycle = LIFECYCLE_LABELS[contact.lifecyclestage ?? ""]
  const leadStatus = LEAD_STATUS_LABELS[contact.hs_lead_status ?? ""]
  const owner = ownerName(owners, contact.hubspot_owner_id)
  const numDeals = contact.num_associated_deals
    ? Number(contact.num_associated_deals)
    : null
  const recentDeal = contact.recent_deal_amount
    ? Number(contact.recent_deal_amount)
    : null

  return {
    type: "upsert" as const,
    key: id,
    upstreamUpdatedAt: updatedAt,
    properties: {
      Name: Builder.title(contactName(contact)),
      ...(lifecycle
        ? { "Lifecycle Stage": Builder.select(lifecycle) }
        : {}),
      ...(leadStatus
        ? { "Lead Status": Builder.select(leadStatus) }
        : {}),
      ...(contact.email
        ? { Email: Builder.email(contact.email) }
        : {}),
      ...(contact.company
        ? { Company: Builder.richText(contact.company) }
        : {}),
      ...(contact.hs_last_sales_activity_timestamp
        ? { "Last Activity": Builder.date(dateOnly(contact.hs_last_sales_activity_timestamp)) }
        : {}),
      ...(contact.jobtitle
        ? { "Job Title": Builder.richText(contact.jobtitle) }
        : {}),
      ...(owner ? { Owner: Builder.richText(owner) } : {}),
      ...(contact.phone
        ? { Phone: Builder.richText(contact.phone) }
        : {}),
      ...(numDeals != null && !isNaN(numDeals)
        ? { "Associated Deals": Builder.number(numDeals) }
        : {}),
      ...(recentDeal != null && !isNaN(recentDeal)
        ? { "Recent Deal Amount": Builder.number(recentDeal) }
        : {}),
      Updated: Builder.date(dateOnly(updatedAt)),
      ...(contact.createdate
        ? { Created: Builder.date(dateOnly(contact.createdate)) }
        : {}),
      "Contact Link": Builder.url(
        `https://app.hubspot.com/contacts/${portalId}/contact/${id}`
      ),
      "Contact ID": Builder.richText(id),
    },
  }
}
