// Salesforce → Notion sync.
//
// Syncs two related objects from a Salesforce org into Notion:
//
//   Accounts ── related to ──> Opportunities
//
// Each object gets the recommended backfill+delta pair:
//
//   - `accountsBackfill` / `opportunitiesBackfill` (replace, manual)
//     Walk the entire object via SOQL on demand. Run after first deploy
//     and any time you need to reconcile (handles hard-deletes since the
//     runtime mark-and-sweeps any record not returned).
//
//   - `accountsDelta` / `opportunitiesDelta` (incremental, every 30 min)
//     Pull only records whose `LastModifiedDate` is newer than the
//     watermark. Day-to-day this is what keeps Notion fresh.
//
// Auth is OAuth 2.0 Web Server Flow against your Salesforce Connected App.
// The runtime stores and refreshes the token; we just call `accessToken()`.

import { Worker } from "@notionhq/workers"
import * as Schema from "@notionhq/workers/schema"
import { getSalesforceClient, toSoqlDateTime } from "./salesforce.js"
import { accountToUpsert, opportunityToUpsert } from "./mapping.js"
import type { SfAccount, SfOpportunity, SfQueryResponse } from "./types.js"

const worker = new Worker()
export default worker

// --- OAuth ---
// Get the Connected App's Consumer Key / Secret from Salesforce Setup
// (App Manager → New Connected App → Enable OAuth Settings). Paste the
// output of `ntn workers oauth show-redirect-url` into the Callback URL
// field there.
const salesforceAuth = worker.oauth("salesforceAuth", {
  name: "salesforce",
  authorizationEndpoint:
    "https://login.salesforce.com/services/oauth2/authorize",
  tokenEndpoint: "https://login.salesforce.com/services/oauth2/token",
  scope: "api refresh_token offline_access",
  clientId: process.env.SF_CLIENT_ID ?? "",
  clientSecret: process.env.SF_CLIENT_SECRET ?? "",
})

// Salesforce API limits depend on org edition, but ~10 req/sec is safe
// even for low-tier orgs. All four syncs share this budget.
const sfApi = worker.pacer("salesforceApi", {
  allowedRequests: 8,
  intervalMs: 1000,
})

// Salesforce indexes LastModifiedDate eventually-consistently. Keep the
// delta cursor a beat behind real time so we don't skip a record that
// was written just before our query ran.
const CONSISTENCY_BUFFER_MS = 30_000

// --- Databases ---

const accounts = worker.database("accounts", {
  type: "managed",
  initialTitle: "Salesforce Accounts",
  primaryKeyProperty: "Account ID",
  schema: {
    properties: {
      Name: Schema.title(),
      "Account ID": Schema.richText(),
      Industry: Schema.richText(),
      Type: Schema.richText(),
      Website: Schema.richText(),
      Owner: Schema.richText(),
      Updated: Schema.date(),
    },
  },
})

const opportunities = worker.database("opportunities", {
  type: "managed",
  initialTitle: "Salesforce Opportunities",
  primaryKeyProperty: "Opportunity ID",
  schema: {
    properties: {
      Name: Schema.title(),
      "Opportunity ID": Schema.richText(),
      Stage: Schema.richText(),
      Amount: Schema.number("dollar"),
      "Close Date": Schema.date(),
      Owner: Schema.richText(),
      Updated: Schema.date(),
      // Two-way relation back into the Accounts database. The other
      // side of the link is auto-created on the Accounts schema as
      // a property called "Opportunities".
      Account: Schema.relation("accounts", {
        twoWay: true,
        relatedPropertyName: "Opportunities",
      }),
    },
  },
})

// --- SOQL queries ---

const ACCOUNT_FIELDS =
  "Id, Name, Industry, Type, Website, Owner.Name, LastModifiedDate"
const OPPORTUNITY_FIELDS =
  "Id, Name, AccountId, StageName, Amount, CloseDate, Owner.Name, LastModifiedDate"

// --- Sync helpers ---
//
// Backfill and delta differ only in their initial SOQL. Both then walk
// the same pagination shape (`nextRecordsUrl` until `done: true`), so we
// share a single runner.

type BackfillState = { nextRecordsUrl: string | null }

type DeltaState = {
  since: string
  nextRecordsUrl: string | null
  maxSeen: string
}

async function runBackfillCycle<T extends { LastModifiedDate: string }>(
  state: BackfillState | undefined,
  initialQuery: string,
  toUpsert: (record: T) => { type: "upsert"; key: string; properties: any }
) {
  const client = await getSalesforceClient(() => salesforceAuth.accessToken())
  await sfApi.wait()
  const response: SfQueryResponse<T> = state?.nextRecordsUrl
    ? await client.next<T>(state.nextRecordsUrl)
    : await client.soql<T>(initialQuery)

  const changes = response.records.map(toUpsert)
  if (response.done) {
    return { changes, hasMore: false, nextState: undefined }
  }
  return {
    changes,
    hasMore: true,
    nextState: { nextRecordsUrl: response.nextRecordsUrl ?? null },
  }
}

async function runDeltaCycle<T extends { LastModifiedDate: string }>(
  state: DeltaState | undefined,
  fields: string,
  objectName: string,
  toUpsert: (record: T) => { type: "upsert"; key: string; properties: any }
) {
  const since = state?.since ?? new Date(0).toISOString()
  const maxSeenSoFar = state?.maxSeen ?? since

  const client = await getSalesforceClient(() => salesforceAuth.accessToken())
  await sfApi.wait()

  let response: SfQueryResponse<T>
  if (state?.nextRecordsUrl) {
    response = await client.next<T>(state.nextRecordsUrl)
  } else {
    const soql = `SELECT ${fields} FROM ${objectName} WHERE LastModifiedDate > ${toSoqlDateTime(since)} ORDER BY LastModifiedDate ASC`
    response = await client.soql<T>(soql)
  }

  const maxSeen = response.records.reduce(
    (m, r) => (r.LastModifiedDate > m ? r.LastModifiedDate : m),
    maxSeenSoFar
  )

  const changes = response.records.map(toUpsert)

  // Mid-cycle: keep `since` pinned, follow the pagination URL next call.
  if (!response.done) {
    return {
      changes,
      hasMore: true,
      nextState: {
        since,
        nextRecordsUrl: response.nextRecordsUrl ?? null,
        maxSeen,
      },
    }
  }

  // End of cycle: advance the watermark, clamped behind the buffer.
  const bufferTs = new Date(Date.now() - CONSISTENCY_BUFFER_MS).toISOString()
  const newSince = maxSeen < bufferTs ? maxSeen : bufferTs
  return {
    changes,
    hasMore: false,
    nextState: { since: newSince, nextRecordsUrl: null, maxSeen: newSince },
  }
}

// --- Account syncs ---

worker.sync("accountsBackfill", {
  database: accounts,
  mode: "replace",
  schedule: "manual",
  execute: (state: BackfillState | undefined) =>
    runBackfillCycle<SfAccount>(
      state,
      `SELECT ${ACCOUNT_FIELDS} FROM Account ORDER BY Id`,
      accountToUpsert
    ),
})

worker.sync("accountsDelta", {
  database: accounts,
  mode: "incremental",
  schedule: "30m",
  execute: (state: DeltaState | undefined) =>
    runDeltaCycle<SfAccount>(state, ACCOUNT_FIELDS, "Account", accountToUpsert),
})

// --- Opportunity syncs ---

worker.sync("opportunitiesBackfill", {
  database: opportunities,
  mode: "replace",
  schedule: "manual",
  execute: (state: BackfillState | undefined) =>
    runBackfillCycle<SfOpportunity>(
      state,
      `SELECT ${OPPORTUNITY_FIELDS} FROM Opportunity ORDER BY Id`,
      opportunityToUpsert
    ),
})

worker.sync("opportunitiesDelta", {
  database: opportunities,
  mode: "incremental",
  schedule: "30m",
  execute: (state: DeltaState | undefined) =>
    runDeltaCycle<SfOpportunity>(
      state,
      OPPORTUNITY_FIELDS,
      "Opportunity",
      opportunityToUpsert
    ),
})
