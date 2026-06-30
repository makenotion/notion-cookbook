// Entry point — syncs Salesforce Accounts and Opportunities into two related
// managed Notion databases.
//
// Each database has:
//   - a 5-minute incremental sync for new and changed records (including
//     queryAll soft-delete markers)
//   - a daily replacement reconciliation for purged deletes, permission
//     changes, and any records missed while the worker was offline

import { Worker } from "@notionhq/workers"

import {
  ACCOUNT_FIELDS,
  INITIAL_TITLE as ACCOUNTS_TITLE,
  PRIMARY_KEY as ACCOUNTS_PK,
  accountSchema,
  accountToChange,
} from "./accounts.js"
import type { SalesforceAccount } from "./accounts.js"
import {
  OPPORTUNITY_FIELDS,
  INITIAL_TITLE as OPPORTUNITIES_TITLE,
  PRIMARY_KEY as OPPORTUNITIES_PK,
  opportunitySchema,
  opportunityToChange,
} from "./opportunities.js"
import type { SalesforceOpportunity } from "./opportunities.js"
import {
  createSalesforceClient,
  getSalesforceLoginUrl,
} from "./salesforce.js"
import {
  runIncrementalPage,
  runReconciliationPage,
} from "./sync.js"
import type {
  IncrementalSyncState,
  ReconciliationSyncState,
  SalesforceResource,
} from "./sync.js"

const worker = new Worker()

// Register OAuth even before credentials exist so the first deployment can
// allocate the callback URL used by the Salesforce External Client App.
const loginUrl = getSalesforceLoginUrl()
const salesforceAuth = worker.oauth("salesforceAuth", {
  name: "salesforce",
  authorizationEndpoint: `${loginUrl}/services/oauth2/authorize`,
  tokenEndpoint: `${loginUrl}/services/oauth2/token`,
  scope: "api refresh_token",
  clientId: process.env.SALESFORCE_CLIENT_ID?.trim() ?? "",
  clientSecret: process.env.SALESFORCE_CLIENT_SECRET?.trim() ?? "",
  // Salesforce can omit expires_in. Give Workers a conservative fallback so
  // it refreshes the access token instead of retaining it indefinitely.
  accessTokenExpireMs: 60 * 60 * 1_000,
})

// Salesforce API quotas vary by edition and license count. This conservative
// shared burst limit prevents all four syncs from issuing requests at once;
// provider limit responses are also surfaced through RateLimitError.
const pacer = worker.pacer("salesforce", {
  allowedRequests: 8,
  intervalMs: 1_000,
})

const createClient = () =>
  createSalesforceClient(
    () => salesforceAuth.accessToken(),
    () => pacer.wait()
  )

const accountResource: SalesforceResource<SalesforceAccount> = {
  objectName: "Account",
  fields: ACCOUNT_FIELDS,
  toChange: accountToChange,
}

const opportunityResource: SalesforceResource<SalesforceOpportunity> = {
  objectName: "Opportunity",
  fields: OPPORTUNITY_FIELDS,
  toChange: opportunityToChange,
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

const accounts = worker.database("accounts", {
  type: "managed",
  initialTitle: ACCOUNTS_TITLE,
  primaryKeyProperty: ACCOUNTS_PK,
  schema: accountSchema,
})

worker.sync("accountsSync", {
  database: accounts,
  mode: "incremental",
  schedule: "5m",
  execute: (state: IncrementalSyncState | undefined) =>
    runIncrementalPage(createClient(), accountResource, state),
})

worker.sync("accountsReconciliation", {
  database: accounts,
  mode: "replace",
  schedule: "1d",
  execute: (state: ReconciliationSyncState | undefined) =>
    runReconciliationPage(createClient(), accountResource, state),
})

// ---------------------------------------------------------------------------
// Opportunities — Account IDs become relations to the Accounts database
// ---------------------------------------------------------------------------

const opportunities = worker.database("opportunities", {
  type: "managed",
  initialTitle: OPPORTUNITIES_TITLE,
  primaryKeyProperty: OPPORTUNITIES_PK,
  schema: opportunitySchema,
})

worker.sync("opportunitiesSync", {
  database: opportunities,
  mode: "incremental",
  schedule: "5m",
  execute: (state: IncrementalSyncState | undefined) =>
    runIncrementalPage(createClient(), opportunityResource, state),
})

worker.sync("opportunitiesReconciliation", {
  database: opportunities,
  mode: "replace",
  schedule: "1d",
  execute: (state: ReconciliationSyncState | undefined) =>
    runReconciliationPage(createClient(), opportunityResource, state),
})

export default worker
