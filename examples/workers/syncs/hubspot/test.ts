// Offline tests for the hubspot sync worker.
// No HubSpot connection is made — all assertions run against pure functions.
// Run: npm test  (or: npx tsx test.ts)

import { contactToChange } from "./src/contacts.js"
import { dealToChange } from "./src/deals.js"
import { companyToChange } from "./src/companies.js"
import { ownerName } from "./src/hubspot.js"
import { dateOnly } from "./src/helpers.js"
import type {
  HubSpotContact,
  HubSpotDeal,
  HubSpotCompany,
  OwnerLookup,
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
  notes_last_updated: "2024-06-16T14:00:00Z",
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
  "Last Activity date",
  JSON.stringify(contactChange.properties["Last Activity"]).includes("2024-06-16")
)
ok(
  "Owner resolved to name",
  JSON.stringify(contactChange.properties.Owner).includes("Jane Smith")
)
ok(
  "Job Title is set",
  JSON.stringify(contactChange.properties["Job Title"]).includes("VP of Engineering")
)
ok(
  "Phone is set",
  JSON.stringify(contactChange.properties.Phone).includes("+1-555-0100")
)
ok(
  "Contact Link contains portal ID and contact ID",
  JSON.stringify(contactChange.properties["Contact Link"]).includes("12345/contact/42")
)
ok(
  "Contact ID is set",
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
  notes_last_updated: null,
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
  createdate: "2024-06-01T10:00:00Z",
}

const dealChange = dealToChange("99", standardDeal, "2024-06-16T14:00:00Z", PORTAL_ID, owners)

ok("key is deal id", dealChange.key === "99")
ok(
  "Deal Name is set",
  JSON.stringify(dealChange.properties["Deal Name"]).includes("Enterprise License")
)
ok(
  "Stage is set",
  JSON.stringify(dealChange.properties.Stage).includes("contractsent")
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
  "Owner resolved to name",
  JSON.stringify(dealChange.properties.Owner).includes("Jane Smith")
)
ok(
  "Deal Link contains portal ID and deal ID",
  JSON.stringify(dealChange.properties["Deal Link"]).includes("12345/deal/99")
)
ok(
  "Pipeline is set",
  JSON.stringify(dealChange.properties.Pipeline).includes("default")
)
ok(
  "Deal Type maps to label",
  JSON.stringify(dealChange.properties["Deal Type"]).includes("New Business")
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
  createdate: null,
}

const minimalDealChange = dealToChange("1", minimalDeal, "2024-01-01", PORTAL_ID, owners)

ok("null stage omits Stage", minimalDealChange.properties.Stage === undefined)
ok("null amount omits Amount", minimalDealChange.properties.Amount === undefined)
ok("null closedate omits Close Date", minimalDealChange.properties["Close Date"] === undefined)
ok("null owner omits Owner", minimalDealChange.properties.Owner === undefined)
ok("null dealtype omits Deal Type", minimalDealChange.properties["Deal Type"] === undefined)

// ---------------------------------------------------------------------------
// companyToChange — standard company
// ---------------------------------------------------------------------------

console.log("companyToChange — standard company:")

const standardCompany: HubSpotCompany = {
  name: "Acme Corp",
  domain: "acme.com",
  industry: "Technology",
  numberofemployees: "250",
  annualrevenue: "10000000",
  hubspot_owner_id: "101",
  type: "CUSTOMER",
  city: "San Francisco",
  country: "United States",
  phone: "+1-555-0200",
  lifecyclestage: "customer",
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
  "Type maps to label",
  JSON.stringify(companyChange.properties.Type).includes("Customer")
)
ok(
  "City is set",
  JSON.stringify(companyChange.properties.City).includes("San Francisco")
)
ok(
  "Company Link contains portal ID",
  JSON.stringify(companyChange.properties["Company Link"]).includes("12345/company/77")
)

// ---------------------------------------------------------------------------
// companyToChange — minimal company
// ---------------------------------------------------------------------------

console.log("companyToChange — minimal company:")

const minimalCompany: HubSpotCompany = {
  name: null,
  domain: null,
  industry: null,
  numberofemployees: null,
  annualrevenue: null,
  hubspot_owner_id: null,
  type: null,
  city: null,
  country: null,
  phone: null,
  lifecyclestage: null,
  createdate: null,
}

const minimalCompanyChange = companyToChange("1", minimalCompany, "2024-01-01", PORTAL_ID, owners)

ok("null industry omits Industry", minimalCompanyChange.properties.Industry === undefined)
ok("null domain omits Domain", minimalCompanyChange.properties.Domain === undefined)
ok("null revenue omits Annual Revenue", minimalCompanyChange.properties["Annual Revenue"] === undefined)
ok("null employees omits Number of Employees", minimalCompanyChange.properties["Number of Employees"] === undefined)
ok("null type omits Type", minimalCompanyChange.properties.Type === undefined)
ok("null city omits City", minimalCompanyChange.properties.City === undefined)

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
