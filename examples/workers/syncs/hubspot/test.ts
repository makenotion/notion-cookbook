// Offline tests for the hubspot sync worker.
// No HubSpot connection is made — all assertions run against pure functions.
// Run: npm test  (or: npx tsx test.ts)

import { contactToChange } from "./src/contacts.js"
import { dealToChange } from "./src/deals.js"
import type { DealContext } from "./src/deals.js"
import { companyToChange } from "./src/companies.js"
import { ownerName } from "./src/hubspot.js"
import { dateOnly } from "./src/helpers.js"
import type {
  HubSpotContact,
  HubSpotDeal,
  HubSpotCompany,
  OwnerLookup,
  PipelineLookup,
} from "./src/hubspot.js"

let passed = 0
let failed = 0

function ok(name: string, cond: boolean) {
  if (cond) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}`)
  }
}

const PORTAL_ID = "12345"

const owners: OwnerLookup = new Map([
  ["101", { id: "101", firstName: "Jane", lastName: "Smith", email: "jane@acme.com" }],
  ["202", { id: "202", firstName: "", lastName: "", email: "sales@acme.com" }],
])

const pipelines: PipelineLookup = {
  pipelineName: (id) => ({ default: "Sales Pipeline", enterprise: "Enterprise" })[id] ?? null,
  stageName: (id) =>
    ({
      appointmentscheduled: "Appointment Scheduled",
      qualifiedtobuy: "Qualified to Buy",
      contractsent: "Contract Sent",
      closedwon: "Closed Won",
      closedlost: "Closed Lost",
    })[id] ?? null,
}

const dealCtx: DealContext = {
  portalId: PORTAL_ID,
  owners,
  pipelines,
  companyNames: new Map([["500", "Acme Corp"]]),
  contactNames: new Map([["600", "Alice Johnson"]]),
}

// ---------------------------------------------------------------------------
// contactToChange — standard contact
// ---------------------------------------------------------------------------

console.log("contactToChange — standard contact:")

const standardContact: HubSpotContact = {
  firstname: "Alice",
  lastname: "Johnson",
  email: "alice@example.com",
  phone: "+1-555-0100",
  company: "Acme Corp",
  jobtitle: "VP of Engineering",
  lifecyclestage: "salesqualifiedlead",
  hs_lead_status: "OPEN",
  hubspot_owner_id: "101",
  hs_last_sales_activity_timestamp: "2024-06-16T14:00:00Z",
  num_associated_deals: "3",
  recent_deal_amount: "50000",
  createdate: "2024-06-01T10:00:00Z",
}

const contactChange = contactToChange("42", standardContact, "2024-06-16T14:00:00Z", PORTAL_ID, owners)

ok("type is upsert", contactChange.type === "upsert")
ok("key is contact id", contactChange.key === "42")
ok(
  "Name combines first and last",
  JSON.stringify(contactChange.properties.Name).includes("Alice Johnson")
)
ok(
  "Lifecycle Stage maps to label",
  JSON.stringify(contactChange.properties["Lifecycle Stage"]).includes("Sales Qualified Lead")
)
ok(
  "Lead Status maps to label",
  JSON.stringify(contactChange.properties["Lead Status"]).includes("Open")
)
ok(
  "Email is set",
  JSON.stringify(contactChange.properties.Email).includes("alice@example.com")
)
ok(
  "Company is set",
  JSON.stringify(contactChange.properties.Company).includes("Acme Corp")
)
ok(
  "Last Activity from sales activity timestamp",
  JSON.stringify(contactChange.properties["Last Activity"]).includes("2024-06-16")
)
ok(
  "Job Title is set",
  JSON.stringify(contactChange.properties["Job Title"]).includes("VP of Engineering")
)
ok(
  "Owner resolved to name",
  JSON.stringify(contactChange.properties.Owner).includes("Jane Smith")
)
ok(
  "Associated Deals is 3",
  JSON.stringify(contactChange.properties["Associated Deals"]).includes("3")
)
ok(
  "Recent Deal Amount is 50000",
  JSON.stringify(contactChange.properties["Recent Deal Amount"]).includes("50000")
)
ok(
  "Updated is set from updatedAt",
  JSON.stringify(contactChange.properties.Updated).includes("2024-06-16")
)
ok(
  "Contact Link contains portal ID and contact ID",
  JSON.stringify(contactChange.properties["Contact Link"]).includes("12345/contact/42")
)
ok(
  "Contact ID is last",
  JSON.stringify(contactChange.properties["Contact ID"]).includes("42")
)

// ---------------------------------------------------------------------------
// contactToChange — minimal contact
// ---------------------------------------------------------------------------

console.log("contactToChange — minimal contact:")

const minimalContact: HubSpotContact = {
  firstname: null,
  lastname: null,
  email: null,
  phone: null,
  company: null,
  jobtitle: null,
  lifecyclestage: null,
  hs_lead_status: null,
  hubspot_owner_id: null,
  hs_last_sales_activity_timestamp: null,
  num_associated_deals: null,
  recent_deal_amount: null,
  createdate: null,
}

const minimalContactChange = contactToChange("1", minimalContact, "2024-01-01", PORTAL_ID, owners)

ok(
  "null names gives (no name)",
  JSON.stringify(minimalContactChange.properties.Name).includes("(no name)")
)
ok("null lifecycle omits Lifecycle Stage", minimalContactChange.properties["Lifecycle Stage"] === undefined)
ok("null lead status omits Lead Status", minimalContactChange.properties["Lead Status"] === undefined)
ok("null email omits Email", minimalContactChange.properties.Email === undefined)
ok("null company omits Company", minimalContactChange.properties.Company === undefined)
ok("null owner omits Owner", minimalContactChange.properties.Owner === undefined)
ok("null jobtitle omits Job Title", minimalContactChange.properties["Job Title"] === undefined)
ok("null phone omits Phone", minimalContactChange.properties.Phone === undefined)
ok("null deals omits Associated Deals", minimalContactChange.properties["Associated Deals"] === undefined)
ok("null deal amount omits Recent Deal Amount", minimalContactChange.properties["Recent Deal Amount"] === undefined)

// ---------------------------------------------------------------------------
// dealToChange — standard deal
// ---------------------------------------------------------------------------

console.log("dealToChange — standard deal:")

const standardDeal: HubSpotDeal = {
  dealname: "Acme Corp - Enterprise License",
  dealstage: "contractsent",
  pipeline: "default",
  amount: "50000",
  closedate: "2024-07-15T00:00:00Z",
  hubspot_owner_id: "101",
  dealtype: "newbusiness",
  hs_forecast_amount: "40000",
  hs_forecast_category: "commit",
  hs_is_closed_won: "false",
  createdate: "2024-06-01T10:00:00Z",
}

const dealAssociations = {
  companies: ["500"],
  contacts: ["600"],
}

const dealChange = dealToChange("99", standardDeal, "2024-06-16T14:00:00Z", dealAssociations, dealCtx)

ok("key is deal id", dealChange.key === "99")
ok(
  "Deal Name is set",
  JSON.stringify(dealChange.properties["Deal Name"]).includes("Enterprise License")
)
ok(
  "Stage resolved to label",
  JSON.stringify(dealChange.properties.Stage).includes("Contract Sent")
)
ok(
  "Amount is numeric",
  JSON.stringify(dealChange.properties.Amount).includes("50000")
)
ok(
  "Close Date is set",
  JSON.stringify(dealChange.properties["Close Date"]).includes("2024-07-15")
)
ok(
  "Pipeline resolved to name",
  JSON.stringify(dealChange.properties.Pipeline).includes("Sales Pipeline")
)
ok(
  "Owner resolved to name",
  JSON.stringify(dealChange.properties.Owner).includes("Jane Smith")
)
ok(
  "Company resolved from association",
  JSON.stringify(dealChange.properties.Company).includes("Acme Corp")
)
ok(
  "Contact resolved from association",
  JSON.stringify(dealChange.properties.Contact).includes("Alice Johnson")
)
ok(
  "Forecast Amount is 40000",
  JSON.stringify(dealChange.properties["Forecast Amount"]).includes("40000")
)
ok(
  "Forecast Category is set",
  JSON.stringify(dealChange.properties["Forecast Category"]).includes("commit")
)
ok(
  "Closed Won is false",
  JSON.stringify(dealChange.properties["Closed Won"]).includes("No")
)
ok(
  "Deal Type maps to label",
  JSON.stringify(dealChange.properties["Deal Type"]).includes("New Business")
)
ok(
  "Updated is set",
  JSON.stringify(dealChange.properties.Updated).includes("2024-06-16")
)
ok(
  "Deal Link contains portal ID",
  JSON.stringify(dealChange.properties["Deal Link"]).includes("12345/deal/99")
)
ok(
  "Stage ID preserved as raw value",
  JSON.stringify(dealChange.properties["Stage ID"]).includes("contractsent")
)
ok(
  "Pipeline ID preserved as raw value",
  JSON.stringify(dealChange.properties["Pipeline ID"]).includes("default")
)
ok(
  "Deal ID is set",
  JSON.stringify(dealChange.properties["Deal ID"]).includes("99")
)

// ---------------------------------------------------------------------------
// dealToChange — unknown stage/pipeline falls back to raw value
// ---------------------------------------------------------------------------

console.log("dealToChange — unknown stage/pipeline:")

const unknownStageDeal: HubSpotDeal = {
  ...standardDeal,
  dealstage: "custom_stage_123",
  pipeline: "custom_pipeline_456",
}

const unknownChange = dealToChange("100", unknownStageDeal, "2024-06-16T14:00:00Z", {}, dealCtx)

ok(
  "unknown stage falls back to raw ID",
  JSON.stringify(unknownChange.properties.Stage).includes("custom_stage_123")
)
ok(
  "unknown pipeline falls back to raw ID",
  JSON.stringify(unknownChange.properties.Pipeline).includes("custom_pipeline_456")
)

// ---------------------------------------------------------------------------
// dealToChange — minimal deal
// ---------------------------------------------------------------------------

console.log("dealToChange — minimal deal:")

const minimalDeal: HubSpotDeal = {
  dealname: null,
  dealstage: null,
  pipeline: null,
  amount: null,
  closedate: null,
  hubspot_owner_id: null,
  dealtype: null,
  hs_forecast_amount: null,
  hs_forecast_category: null,
  hs_is_closed_won: null,
  createdate: null,
}

const minimalDealChange = dealToChange("1", minimalDeal, "2024-01-01", {}, dealCtx)

ok("null stage omits Stage", minimalDealChange.properties.Stage === undefined)
ok("null amount omits Amount", minimalDealChange.properties.Amount === undefined)
ok("null closedate omits Close Date", minimalDealChange.properties["Close Date"] === undefined)
ok("null pipeline omits Pipeline", minimalDealChange.properties.Pipeline === undefined)
ok("null owner omits Owner", minimalDealChange.properties.Owner === undefined)
ok("no associations omits Company", minimalDealChange.properties.Company === undefined)
ok("no associations omits Contact", minimalDealChange.properties.Contact === undefined)
ok("null forecast omits Forecast Amount", minimalDealChange.properties["Forecast Amount"] === undefined)
ok("null forecast category omits Forecast Category", minimalDealChange.properties["Forecast Category"] === undefined)
ok("null dealtype omits Deal Type", minimalDealChange.properties["Deal Type"] === undefined)
ok("null stage omits Stage ID", minimalDealChange.properties["Stage ID"] === undefined)
ok("null pipeline omits Pipeline ID", minimalDealChange.properties["Pipeline ID"] === undefined)

// ---------------------------------------------------------------------------
// dealToChange — closed won deal
// ---------------------------------------------------------------------------

console.log("dealToChange — closed won:")

const closedWonDeal: HubSpotDeal = {
  ...standardDeal,
  dealstage: "closedwon",
  hs_is_closed_won: "true",
}

const closedWonChange = dealToChange("200", closedWonDeal, "2024-07-15", dealAssociations, dealCtx)

ok(
  "Stage is Closed Won",
  JSON.stringify(closedWonChange.properties.Stage).includes("Closed Won")
)
ok(
  "Closed Won is true",
  JSON.stringify(closedWonChange.properties["Closed Won"]).includes("Yes")
)

// ---------------------------------------------------------------------------
// companyToChange — standard company
// ---------------------------------------------------------------------------

console.log("companyToChange — standard company:")

const standardCompany: HubSpotCompany = {
  name: "Acme Corp",
  domain: "acme.com",
  description: "A leading technology company.",
  industry: "Technology",
  numberofemployees: "250",
  annualrevenue: "10000000",
  hubspot_owner_id: "101",
  type: "CUSTOMER",
  city: "San Francisco",
  country: "United States",
  phone: "+1-555-0200",
  lifecyclestage: "customer",
  hs_num_open_deals: "5",
  total_revenue: "2500000",
  createdate: "2024-01-15T10:00:00Z",
}

const companyChange = companyToChange("77", standardCompany, "2024-06-16T14:00:00Z", PORTAL_ID, owners)

ok("key is company id", companyChange.key === "77")
ok(
  "Name is set",
  JSON.stringify(companyChange.properties.Name).includes("Acme Corp")
)
ok(
  "Industry is set",
  JSON.stringify(companyChange.properties.Industry).includes("Technology")
)
ok(
  "Domain is URL",
  JSON.stringify(companyChange.properties.Domain).includes("https://acme.com")
)
ok(
  "Annual Revenue is numeric",
  JSON.stringify(companyChange.properties["Annual Revenue"]).includes("10000000")
)
ok(
  "Number of Employees is numeric",
  JSON.stringify(companyChange.properties["Number of Employees"]).includes("250")
)
ok(
  "Owner resolved to name",
  JSON.stringify(companyChange.properties.Owner).includes("Jane Smith")
)
ok(
  "Open Deals is 5",
  JSON.stringify(companyChange.properties["Open Deals"]).includes("5")
)
ok(
  "Total Revenue is 2500000",
  JSON.stringify(companyChange.properties["Total Revenue"]).includes("2500000")
)
ok(
  "Lifecycle Stage maps to label",
  JSON.stringify(companyChange.properties["Lifecycle Stage"]).includes("Customer")
)
ok(
  "Type maps to label",
  JSON.stringify(companyChange.properties.Type).includes("Customer")
)
ok(
  "City is set",
  JSON.stringify(companyChange.properties.City).includes("San Francisco")
)
ok(
  "pageContentMarkdown contains description",
  companyChange.pageContentMarkdown.includes("leading technology")
)
ok(
  "Updated is set",
  JSON.stringify(companyChange.properties.Updated).includes("2024-06-16")
)
ok(
  "Company Link contains portal ID",
  JSON.stringify(companyChange.properties["Company Link"]).includes("12345/company/77")
)
ok(
  "Company ID is set",
  JSON.stringify(companyChange.properties["Company ID"]).includes("77")
)

// ---------------------------------------------------------------------------
// companyToChange — minimal company
// ---------------------------------------------------------------------------

console.log("companyToChange — minimal company:")

const minimalCompany: HubSpotCompany = {
  name: null,
  domain: null,
  description: null,
  industry: null,
  numberofemployees: null,
  annualrevenue: null,
  hubspot_owner_id: null,
  type: null,
  city: null,
  country: null,
  phone: null,
  lifecyclestage: null,
  hs_num_open_deals: null,
  total_revenue: null,
  createdate: null,
}

const minimalCompanyChange = companyToChange("1", minimalCompany, "2024-01-01", PORTAL_ID, owners)

ok("null industry omits Industry", minimalCompanyChange.properties.Industry === undefined)
ok("null domain omits Domain", minimalCompanyChange.properties.Domain === undefined)
ok("null revenue omits Annual Revenue", minimalCompanyChange.properties["Annual Revenue"] === undefined)
ok("null employees omits Number of Employees", minimalCompanyChange.properties["Number of Employees"] === undefined)
ok("null owner omits Owner", minimalCompanyChange.properties.Owner === undefined)
ok("null open deals omits Open Deals", minimalCompanyChange.properties["Open Deals"] === undefined)
ok("null total revenue omits Total Revenue", minimalCompanyChange.properties["Total Revenue"] === undefined)
ok("null lifecycle omits Lifecycle Stage", minimalCompanyChange.properties["Lifecycle Stage"] === undefined)
ok("null type omits Type", minimalCompanyChange.properties.Type === undefined)
ok("null city omits City", minimalCompanyChange.properties.City === undefined)
ok("null description gives empty pageContentMarkdown", minimalCompanyChange.pageContentMarkdown === "")

// ---------------------------------------------------------------------------
// ownerName — resolves owner IDs
// ---------------------------------------------------------------------------

console.log("ownerName:")

ok("resolves known owner", ownerName(owners, "101") === "Jane Smith")
ok("falls back to email when no name", ownerName(owners, "202") === "sales@acme.com")
ok("null id returns null", ownerName(owners, null) === null)
ok("unknown id returns null", ownerName(owners, "999") === null)

// ---------------------------------------------------------------------------
// dateOnly
// ---------------------------------------------------------------------------

console.log("dateOnly:")

ok("ISO timestamp returns date part", dateOnly("2024-03-15T12:00:00Z") === "2024-03-15")
ok("plain date passes through", dateOnly("2024-03-15") === "2024-03-15")
ok("empty string returns empty", dateOnly("") === "")

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
