// Offline tests for the Salesforce sync worker.
// No Salesforce connection is made — HTTP assertions use mocked responses.
// Run: npm test  (or: npx tsx test.ts)

import { RateLimitError, type SyncChangeUpsert } from "@notionhq/workers"
import type { PropertySchema } from "@notionhq/workers/schema"

import worker from "./src/index.js"
import { accountToChange, type SalesforceAccount } from "./src/accounts.js"
import {
  opportunityToChange,
  type SalesforceOpportunity,
} from "./src/opportunities.js"
import {
  SALESFORCE_API_VERSION,
  createSalesforceClient,
  createSalesforceSessionProvider,
  getSalesforceOrgUrl,
  type SalesforceClient,
  type SalesforceQueryPage,
  type SalesforceSessionProvider,
} from "./src/salesforce.js"
import {
  incrementalSoql,
  reconciliationSoql,
  runIncrementalPage,
  runReconciliationPage,
  type SalesforceRecord,
  type SalesforceResource,
} from "./src/sync.js"

let passed = 0
let failed = 0

function ok(name: string, condition: boolean) {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}`)
  }
}

function contains(value: unknown, expected: string | number): boolean {
  return JSON.stringify(value).includes(String(expected))
}

function isEmptyProperty(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0
}

async function captureError(action: () => unknown | Promise<unknown>) {
  try {
    await action()
  } catch (error) {
    return error
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Account mapping
// ---------------------------------------------------------------------------

console.log("accountToChange:")

const fullAccount: SalesforceAccount = {
  Id: "001Acme",
  IsDeleted: false,
  Name: "Acme Corporation",
  Industry: "Technology",
  Type: "Customer",
  Website: "https://acme.example",
  Phone: "+1 415 555 0100",
  BillingCity: "San Francisco",
  BillingCountry: "United States",
  AnnualRevenue: 12_500_000,
  NumberOfEmployees: 420,
  Owner: { Name: "Ada Lovelace" },
  CreatedDate: "2024-01-02T03:04:05.000Z",
  LastModifiedDate: "2024-06-02T03:04:05.000Z",
  SystemModstamp: "2024-06-02T03:05:00.000Z",
  Description: "Strategic account\n\nRenewal is in Q4.",
}

const accountChange = accountToChange(
  fullAccount,
  "https://acme.my.salesforce.com/"
)

ok("account is emitted as an upsert", accountChange.type === "upsert")
ok("account key is the Salesforce ID", accountChange.key === fullAccount.Id)
ok(
  "account uses SystemModstamp as its upstream timestamp",
  accountChange.upstreamUpdatedAt === fullAccount.SystemModstamp
)
ok(
  "account description becomes the page body",
  accountChange.pageContentMarkdown === fullAccount.Description
)
ok(
  "account maps its standard fields",
  contains(accountChange.properties.Name, fullAccount.Name) &&
    contains(accountChange.properties.Industry, "Technology") &&
    contains(accountChange.properties.Type, "Customer") &&
    contains(accountChange.properties.Website, "https://acme.example") &&
    contains(accountChange.properties.Phone, "+1 415 555 0100") &&
    contains(accountChange.properties["Billing City"], "San Francisco") &&
    contains(accountChange.properties["Billing Country"], "United States") &&
    contains(accountChange.properties["Annual Revenue"], 12_500_000) &&
    contains(accountChange.properties.Employees, 420) &&
    contains(accountChange.properties.Owner, "Ada Lovelace")
)
ok(
  "account dates and ID are mapped",
  contains(accountChange.properties.Created, "2024-01-02") &&
    contains(accountChange.properties.Updated, "2024-06-02") &&
    contains(accountChange.properties["Account ID"], fullAccount.Id)
)
ok(
  "account link points to Lightning and trims trailing slashes",
  contains(
    accountChange.properties["Account Link"],
    `https://acme.my.salesforce.com/lightning/r/Account/${fullAccount.Id}/view`
  )
)

const zeroAccountChange = accountToChange(
  {
    ...fullAccount,
    AnnualRevenue: 0,
    NumberOfEmployees: 0,
  },
  "https://acme.my.salesforce.com"
)
ok(
  "account preserves zero-valued numbers",
  JSON.stringify(zeroAccountChange.properties["Annual Revenue"]) ===
    '[["0"]]' &&
    JSON.stringify(zeroAccountChange.properties.Employees) === '[["0"]]'
)

const nullAccountChange = accountToChange(
  {
    ...fullAccount,
    Industry: null,
    Type: null,
    Website: null,
    Phone: null,
    BillingCity: null,
    BillingCountry: null,
    AnnualRevenue: null,
    NumberOfEmployees: null,
    Owner: null,
    Description: null,
  },
  "https://acme.my.salesforce.com"
)
ok(
  "null account fields explicitly clear previous Notion values",
  isEmptyProperty(nullAccountChange.properties.Industry) &&
    isEmptyProperty(nullAccountChange.properties.Type) &&
    isEmptyProperty(nullAccountChange.properties.Website) &&
    isEmptyProperty(nullAccountChange.properties.Phone) &&
    isEmptyProperty(nullAccountChange.properties["Billing City"]) &&
    isEmptyProperty(nullAccountChange.properties["Billing Country"]) &&
    isEmptyProperty(nullAccountChange.properties["Annual Revenue"]) &&
    isEmptyProperty(nullAccountChange.properties.Employees) &&
    isEmptyProperty(nullAccountChange.properties.Owner)
)
const invalidWebsiteChange = accountToChange(
  { ...fullAccount, Website: "javascript:alert(1)" },
  "https://acme.my.salesforce.com"
)
ok(
  "invalid account websites clear a previous Notion URL",
  isEmptyProperty(invalidWebsiteChange.properties.Website)
)
ok(
  "null account description becomes an empty body",
  nullAccountChange.pageContentMarkdown === ""
)

// ---------------------------------------------------------------------------
// Opportunity mapping
// ---------------------------------------------------------------------------

console.log("opportunityToChange:")

const fullOpportunity: SalesforceOpportunity = {
  Id: "006Renewal",
  IsDeleted: false,
  Name: "Acme renewal",
  StageName: "Negotiation/Review",
  Amount: 75_000,
  Probability: 35,
  CloseDate: "2024-12-31",
  Type: "Existing Business",
  LeadSource: "Partner Referral",
  ForecastCategoryName: "Best Case",
  IsClosed: false,
  IsWon: false,
  Owner: { Name: "Grace Hopper" },
  AccountId: fullAccount.Id,
  CreatedDate: "2024-02-03T04:05:06.000Z",
  LastModifiedDate: "2024-07-03T04:05:06.000Z",
  SystemModstamp: "2024-07-03T04:06:00.000Z",
  Description: "Renewal for the enterprise plan.",
}

const opportunityChange = opportunityToChange(
  fullOpportunity,
  "https://acme.my.salesforce.com/"
)

ok(
  "opportunity is emitted as an upsert with its Salesforce ID",
  opportunityChange.type === "upsert" &&
    opportunityChange.key === fullOpportunity.Id
)
ok(
  "opportunity maps standard fields",
  contains(opportunityChange.properties.Name, "Acme renewal") &&
    contains(opportunityChange.properties.Stage, "Negotiation/Review") &&
    contains(opportunityChange.properties.Amount, 75_000) &&
    contains(opportunityChange.properties["Close Date"], "2024-12-31") &&
    contains(opportunityChange.properties.Type, "Existing Business") &&
    contains(opportunityChange.properties["Lead Source"], "Partner Referral") &&
    contains(opportunityChange.properties["Forecast Category"], "Best Case") &&
    contains(opportunityChange.properties.Owner, "Grace Hopper")
)
ok(
  "opportunity converts Salesforce percent values to decimal values",
  JSON.stringify(opportunityChange.properties.Probability) === '[["0.35"]]'
)
ok(
  "opportunity preserves boolean values",
  contains(opportunityChange.properties["Is Closed"], "No") &&
    contains(opportunityChange.properties["Is Won"], "No")
)
ok(
  "opportunity relates to its account by primary key",
  JSON.stringify(opportunityChange.properties.Account) ===
    `[{"type":"primaryKey","value":"${fullAccount.Id}"}]`
)
ok(
  "opportunity uses its body and SystemModstamp",
  opportunityChange.pageContentMarkdown === fullOpportunity.Description &&
    opportunityChange.upstreamUpdatedAt === fullOpportunity.SystemModstamp
)
ok(
  "opportunity link points to Lightning and trims trailing slashes",
  contains(
    opportunityChange.properties["Opportunity Link"],
    `https://acme.my.salesforce.com/lightning/r/Opportunity/${fullOpportunity.Id}/view`
  )
)
ok(
  "opportunity maps dates and its ID",
  contains(opportunityChange.properties.Created, "2024-02-03") &&
    contains(opportunityChange.properties.Updated, "2024-07-03") &&
    contains(opportunityChange.properties["Opportunity ID"], fullOpportunity.Id)
)

const zeroOpportunityChange = opportunityToChange(
  { ...fullOpportunity, Amount: 0, Probability: 0 },
  "https://acme.my.salesforce.com"
)
ok(
  "opportunity preserves zero amount and probability",
  JSON.stringify(zeroOpportunityChange.properties.Amount) === '[["0"]]' &&
    JSON.stringify(zeroOpportunityChange.properties.Probability) === '[["0"]]'
)

const nullOpportunityChange = opportunityToChange(
  {
    ...fullOpportunity,
    Amount: null,
    Probability: null,
    Type: null,
    LeadSource: null,
    ForecastCategoryName: null,
    Owner: null,
    AccountId: null,
    Description: null,
  },
  "https://acme.my.salesforce.com"
)
ok(
  "null opportunity fields explicitly clear previous Notion values",
  isEmptyProperty(nullOpportunityChange.properties.Amount) &&
    isEmptyProperty(nullOpportunityChange.properties.Probability) &&
    isEmptyProperty(nullOpportunityChange.properties.Type) &&
    isEmptyProperty(nullOpportunityChange.properties["Lead Source"]) &&
    isEmptyProperty(nullOpportunityChange.properties["Forecast Category"]) &&
    isEmptyProperty(nullOpportunityChange.properties.Owner) &&
    isEmptyProperty(nullOpportunityChange.properties.Account)
)
ok(
  "null opportunity description becomes an empty body",
  nullOpportunityChange.pageContentMarkdown === ""
)

// ---------------------------------------------------------------------------
// Configured Salesforce origins
// ---------------------------------------------------------------------------

function runUrlConfigurationTests() {
  console.log("Salesforce URL configuration:")

  const originalOrgUrl = process.env.SALESFORCE_ORG_URL

  try {
    process.env.SALESFORCE_ORG_URL = " https://acme.my.salesforce.com/ "
    ok(
      "org URL is normalized to its HTTPS origin",
      getSalesforceOrgUrl() === "https://acme.my.salesforce.com"
    )

    delete process.env.SALESFORCE_ORG_URL
    ok(
      "org URL is required",
      captureSynchronousError(getSalesforceOrgUrl) instanceof Error
    )

    const invalidOrigins = [
      "not a URL",
      "http://acme.my.salesforce.com",
      "https://user:password@acme.my.salesforce.com",
      "https://acme.my.salesforce.com/services/data",
      "https://acme.my.salesforce.com?query=yes",
      "https://acme.my.salesforce.com#fragment",
    ]
    ok(
      "org URL rejects non-HTTPS values and URL components",
      invalidOrigins.every((value) => {
        process.env.SALESFORCE_ORG_URL = value
        return captureSynchronousError(getSalesforceOrgUrl) instanceof Error
      })
    )
  } finally {
    if (originalOrgUrl === undefined) delete process.env.SALESFORCE_ORG_URL
    else process.env.SALESFORCE_ORG_URL = originalOrgUrl
  }
}

function captureSynchronousError(action: () => unknown): unknown {
  try {
    action()
  } catch (error) {
    return error
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Salesforce client-credentials session — mocked HTTP only
// ---------------------------------------------------------------------------

async function runSessionProviderTests() {
  console.log("Salesforce client credentials:")

  const originalFetch = globalThis.fetch
  const originalClientId = process.env.SALESFORCE_CLIENT_ID
  const originalClientSecret = process.env.SALESFORCE_CLIENT_SECRET
  const originalOrgUrl = process.env.SALESFORCE_ORG_URL
  process.env.SALESFORCE_CLIENT_ID = "client-id"
  process.env.SALESFORCE_CLIENT_SECRET = "client-secret"
  process.env.SALESFORCE_ORG_URL = "https://acme.my.salesforce.com"

  try {
    const requests: Request[] = []
    const tokenResponses = [
      {
        access_token: "access-token-1",
        instance_url: "https://acme.my.salesforce.com/",
        token_type: "Bearer",
      },
      {
        access_token: "access-token-2",
        instance_url: "https://acme.my.salesforce.com",
        token_type: "Bearer",
      },
    ]
    globalThis.fetch = (async (input, init) => {
      requests.push(new Request(input, init))
      return new Response(JSON.stringify(tokenResponses.shift()), {
        status: 200,
      })
    }) as typeof fetch

    const provider = createSalesforceSessionProvider()
    const [firstSession, concurrentSession] = await Promise.all([
      provider.getSession(),
      provider.getSession(),
    ])
    const request = requests[0]
    const body = new URLSearchParams(await request.text())
    ok(
      "client credentials use one concurrent token exchange",
      requests.length === 1 &&
        firstSession.accessToken === "access-token-1" &&
        concurrentSession === firstSession
    )
    ok(
      "token exchange uses the org My Domain and HTTP Basic authentication",
      request.method === "POST" &&
        new URL(request.url).pathname === "/services/oauth2/token" &&
        request.headers.get("Authorization") ===
          `Basic ${Buffer.from("client-id:client-secret").toString("base64")}` &&
        request.headers
          .get("Content-Type")
          ?.startsWith("application/x-www-form-urlencoded") === true &&
        body.get("grant_type") === "client_credentials" &&
        body.size === 1
    )
    ok(
      "Salesforce instance URL is normalized from the token response",
      firstSession.instanceUrl === "https://acme.my.salesforce.com"
    )

    provider.invalidate("another-token")
    await provider.getSession()
    provider.invalidate(firstSession.accessToken)
    const renewedSession = await provider.getSession()
    ok(
      "only the active token can invalidate the cached session",
      requests.length === 2 && renewedSession.accessToken === "access-token-2"
    )
  } finally {
    globalThis.fetch = originalFetch
    if (originalClientId === undefined) delete process.env.SALESFORCE_CLIENT_ID
    else process.env.SALESFORCE_CLIENT_ID = originalClientId
    if (originalClientSecret === undefined)
      delete process.env.SALESFORCE_CLIENT_SECRET
    else process.env.SALESFORCE_CLIENT_SECRET = originalClientSecret
    if (originalOrgUrl === undefined) delete process.env.SALESFORCE_ORG_URL
    else process.env.SALESFORCE_ORG_URL = originalOrgUrl
  }
}

// ---------------------------------------------------------------------------
// Salesforce API client — mocked HTTP only
// ---------------------------------------------------------------------------

async function runApiClientTests() {
  console.log("Salesforce API client:")

  const originalFetch = globalThis.fetch
  const originalOrgUrl = process.env.SALESFORCE_ORG_URL
  process.env.SALESFORCE_ORG_URL = "https://acme.my.salesforce.com"

  try {
    const requests: Request[] = []
    let waits = 0
    let tokenRequests = 0
    const responses = [
      {
        totalSize: 1,
        done: false,
        records: [{ Id: "001Acme" }],
        nextRecordsUrl: `/services/data/${SALESFORCE_API_VERSION}/query/01g-next`,
      },
      { totalSize: 0, done: true, records: [] },
      { totalSize: 1, done: true, records: [{ Id: "001Next" }] },
    ]

    globalThis.fetch = (async (input, init) => {
      requests.push(new Request(input, init))
      const response = responses.shift()
      return new Response(JSON.stringify(response), { status: 200 })
    }) as typeof fetch

    const sessionProvider: SalesforceSessionProvider = {
      async getSession() {
        tokenRequests++
        return {
          accessToken: "salesforce-access-token",
          instanceUrl: "https://acme.my.salesforce.com",
        }
      },
      invalidate() {},
    }
    const client = createSalesforceClient(sessionProvider, async () => {
      waits++
    })
    const soql = "SELECT Id FROM Account WHERE Name = 'A&B'"
    const firstPage = await client.queryPage<{ Id: string }>(soql)
    const queryAllPage = await client.queryPage<{ Id: string }>(
      soql,
      undefined,
      true
    )
    const cursorPage = await client.queryPage<{ Id: string }>(
      "THIS QUERY IS IGNORED FOR A CURSOR",
      firstPage.nextCursor
    )

    const queryUrl = new URL(requests[0].url)
    const queryAllUrl = new URL(requests[1].url)
    const cursorUrl = new URL(requests[2].url)
    ok(
      "standard queries use the current versioned query endpoint",
      SALESFORCE_API_VERSION === "v67.0" &&
        queryUrl.pathname === "/services/data/v67.0/query/"
    )
    ok(
      "deleted-record queries use queryAll",
      queryAllUrl.pathname === "/services/data/v67.0/queryAll/" &&
        queryAllPage.done
    )
    ok(
      "SOQL is URL encoded without changing its value",
      queryUrl.searchParams.get("q") === soql &&
        !requests[0].url.includes("Name = 'A&B'")
    )
    ok(
      "pagination follows Salesforce's relative query cursor",
      firstPage.nextCursor === "/services/data/v67.0/query/01g-next" &&
        cursorUrl.pathname === "/services/data/v67.0/query/01g-next" &&
        !cursorUrl.searchParams.has("q") &&
        cursorPage.records[0].Id === "001Next" &&
        cursorPage.nextCursor === undefined
    )
    ok(
      "each request is paced and obtains the current Salesforce session",
      waits === 3 && tokenRequests === 3
    )
    ok(
      "requests send bearer, JSON, and 2000-record batch headers",
      requests.every(
        (request) =>
          request.headers.get("Authorization") ===
            "Bearer salesforce-access-token" &&
          request.headers.get("Accept") === "application/json" &&
          request.headers.get("Sforce-Query-Options") === "batchSize=2000" &&
          request.redirect === "error"
      )
    )

    const invalidCursorErrors = await Promise.all(
      [
        "not-a-relative-path",
        "/services/data/v66.0/query/old-version",
        "/services/data/v67.0/sobjects/Account",
        "//evil.example/services/data/v67.0/query/cursor",
      ].map((cursor) =>
        captureError(() => client.queryPage("SELECT Id FROM Account", cursor))
      )
    )
    ok(
      "pagination rejects malformed, cross-origin, and non-query cursors",
      invalidCursorErrors.every((error) => error instanceof Error) &&
        requests.length === 3
    )

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ totalSize: 1, done: false, records: [] }), {
        status: 200,
      })) as typeof fetch
    const missingCursorError = await captureError(() =>
      client.queryPage("SELECT Id FROM Account")
    )
    ok(
      "non-terminal pages require nextRecordsUrl",
      missingCursorError instanceof Error &&
        missingCursorError.message.includes("missing nextRecordsUrl")
    )

    globalThis.fetch = (async () =>
      new Response("Too many requests", {
        status: 429,
        headers: { "Retry-After": "7" },
      })) as typeof fetch
    const rateLimitError = await captureError(() =>
      client.queryPage("SELECT Id FROM Account")
    )
    ok(
      "429 responses preserve Retry-After for Workers backoff",
      rateLimitError instanceof RateLimitError &&
        rateLimitError.retryAfter === 7
    )

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          {
            errorCode: "REQUEST_LIMIT_EXCEEDED",
            message: "Concurrent API request limit exceeded.",
          },
        ]),
        { status: 403 }
      )) as typeof fetch
    const requestLimitError = await captureError(() =>
      client.queryPage("SELECT Id FROM Account")
    )
    ok(
      "Salesforce REQUEST_LIMIT_EXCEEDED errors trigger Workers backoff",
      requestLimitError instanceof RateLimitError &&
        requestLimitError.retryAfter === undefined
    )

    let activeToken = "expired-token"
    const invalidatedTokens: string[] = []
    const authRequests: Request[] = []
    const retryProvider: SalesforceSessionProvider = {
      async getSession() {
        return {
          accessToken: activeToken,
          instanceUrl: "https://acme.my.salesforce.com",
        }
      },
      invalidate(accessToken) {
        invalidatedTokens.push(accessToken)
        if (accessToken === activeToken) activeToken = "renewed-token"
      },
    }
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init)
      authRequests.push(request)
      if (request.headers.get("Authorization") === "Bearer expired-token") {
        return new Response(
          JSON.stringify([
            { errorCode: "INVALID_SESSION_ID", message: "Session expired" },
          ]),
          { status: 401 }
        )
      }
      return new Response(
        JSON.stringify({ totalSize: 0, done: true, records: [] }),
        { status: 200 }
      )
    }) as typeof fetch
    const retryClient = createSalesforceClient(retryProvider, async () => {})
    const retriedPage = await retryClient.queryPage("SELECT Id FROM Account")
    ok(
      "a 401 renews the client-credentials token and retries once",
      retriedPage.done &&
        authRequests.length === 2 &&
        invalidatedTokens.length === 1 &&
        invalidatedTokens[0] === "expired-token" &&
        authRequests[1].headers.get("Authorization") === "Bearer renewed-token"
    )
  } finally {
    globalThis.fetch = originalFetch
    if (originalOrgUrl === undefined) delete process.env.SALESFORCE_ORG_URL
    else process.env.SALESFORCE_ORG_URL = originalOrgUrl
  }
}

// ---------------------------------------------------------------------------
// Incremental and reconciliation lifecycle
// ---------------------------------------------------------------------------

type TestRecord = SalesforceRecord & { Name: string }

const testResource: SalesforceResource<
  TestRecord,
  SyncChangeUpsert<string, PropertySchema<string>>
> = {
  objectName: "Account",
  fields: ["Id", "IsDeleted", "Name", "SystemModstamp"],
  toChange: (record, instanceUrl) => ({
    type: "upsert",
    key: record.Id,
    upstreamUpdatedAt: record.SystemModstamp,
    pageContentMarkdown: record.Name,
    properties: { Name: [[record.Name]], Instance: [[instanceUrl]] },
  }),
}

type QueryCall = {
  soql: string
  cursor: string | undefined
  includeDeleted: boolean | undefined
}

function fakeClient(
  pages: SalesforceQueryPage<TestRecord>[],
  calls: QueryCall[]
): SalesforceClient {
  return {
    instanceUrl: "https://acme.my.salesforce.com",
    async queryPage<T>(
      soql: string,
      cursor?: string,
      includeDeleted?: boolean
    ) {
      calls.push({ soql, cursor, includeDeleted })
      const page = pages.shift()
      if (!page) throw new Error("Fake Salesforce client ran out of pages.")
      return page as unknown as SalesforceQueryPage<T>
    },
  }
}

function record(
  Id: string,
  Name: string,
  SystemModstamp: string,
  IsDeleted = false
): TestRecord {
  return { Id, Name, SystemModstamp, IsDeleted }
}

async function runSyncLifecycleTests() {
  console.log("Salesforce sync lifecycle:")

  const firstWindowEnd = new Date("2024-08-20T12:00:00.000Z")
  const incrementalPages: SalesforceQueryPage<TestRecord>[] = [
    {
      records: [
        record("001Changed", "Changed account", "2024-08-20T11:50:00.000Z"),
        record(
          "001Deleted",
          "Deleted account",
          "2024-08-20T11:51:00.000Z",
          true
        ),
      ],
      done: false,
      nextCursor: "/services/data/v67.0/query/incremental-next",
    },
    {
      records: [
        record("001Later", "Later account", "2024-08-20T11:55:00.000Z"),
      ],
      done: true,
    },
  ]
  const incrementalCalls: QueryCall[] = []
  const incrementalClient = fakeClient(incrementalPages, incrementalCalls)

  const firstIncrementalPage = await runIncrementalPage(
    incrementalClient,
    testResource,
    undefined,
    () => firstWindowEnd
  )
  const expectedIncrementalSoql = [
    "SELECT Id, IsDeleted, Name, SystemModstamp FROM Account",
    "WHERE SystemModstamp > 1970-01-01T00:00:00Z",
    "AND SystemModstamp <= 2024-08-20T12:00:00Z",
    "ORDER BY SystemModstamp ASC, Id ASC",
  ].join(" ")
  ok(
    "incremental query uses a fixed inclusive window and stable order",
    incrementalCalls[0].soql === expectedIncrementalSoql
  )
  ok(
    "incremental pages include Salesforce soft-delete markers",
    incrementalCalls[0].includeDeleted === true &&
      firstIncrementalPage.changes[0].type === "upsert" &&
      firstIncrementalPage.changes[1].type === "delete" &&
      firstIncrementalPage.changes[1].key === "001Deleted"
  )
  ok(
    "incremental pagination persists the original window and cursor",
    firstIncrementalPage.hasMore &&
      firstIncrementalPage.nextState.since === "1970-01-01T00:00:00.000Z" &&
      firstIncrementalPage.nextState.until === firstWindowEnd.toISOString() &&
      firstIncrementalPage.nextState.nextCursor ===
        "/services/data/v67.0/query/incremental-next"
  )

  const secondIncrementalPage = await runIncrementalPage(
    incrementalClient,
    testResource,
    firstIncrementalPage.nextState,
    () => new Date("2024-08-20T13:00:00.000Z")
  )
  ok(
    "later pages keep the first page's upper bound",
    incrementalCalls[1].soql === incrementalCalls[0].soql &&
      incrementalCalls[1].cursor ===
        "/services/data/v67.0/query/incremental-next" &&
      incrementalCalls[1].includeDeleted === true
  )
  ok(
    "terminal incremental page checkpoints with a two-minute overlap",
    !secondIncrementalPage.hasMore &&
      secondIncrementalPage.nextState.since === "2024-08-20T11:58:00.000Z" &&
      secondIncrementalPage.nextState.until === undefined &&
      secondIncrementalPage.nextState.nextCursor === undefined
  )

  const callsBeforeInvalidState = incrementalCalls.length
  const missingWindowError = await captureError(() =>
    runIncrementalPage(incrementalClient, testResource, {
      since: "2024-08-20T11:00:00.000Z",
      nextCursor: "/services/data/v67.0/query/missing-window",
    })
  )
  ok(
    "paginated incremental state requires its fixed upper bound",
    missingWindowError instanceof Error &&
      missingWindowError.message.includes("missing until") &&
      incrementalCalls.length === callsBeforeInvalidState
  )

  ok(
    "SOQL helpers normalize timestamps and select declared fields",
    incrementalSoql(
      testResource,
      "2024-08-20T10:00:00.123Z",
      "2024-08-20T11:00:00.987Z"
    ).includes(
      "SystemModstamp > 2024-08-20T10:00:00Z AND SystemModstamp <= 2024-08-20T11:00:00Z"
    ) &&
      reconciliationSoql(testResource) ===
        "SELECT Id, IsDeleted, Name, SystemModstamp FROM Account ORDER BY Id ASC"
  )

  const reconciliationPages: SalesforceQueryPage<TestRecord>[] = [
    {
      records: [
        record("001First", "First account", "2024-08-20T11:00:00.000Z"),
      ],
      done: false,
      nextCursor: "/services/data/v67.0/query/reconciliation-next",
    },
    {
      records: [
        record("001Second", "Second account", "2024-08-20T11:10:00.000Z"),
      ],
      done: true,
    },
  ]
  const reconciliationCalls: QueryCall[] = []
  const reconciliationClient = fakeClient(
    reconciliationPages,
    reconciliationCalls
  )
  const firstReconciliationPage = await runReconciliationPage(
    reconciliationClient,
    testResource,
    undefined
  )
  const finalReconciliationPage = await runReconciliationPage(
    reconciliationClient,
    testResource,
    firstReconciliationPage.nextState
  )
  ok(
    "replacement reconciliation follows query pagination",
    firstReconciliationPage.hasMore &&
      firstReconciliationPage.nextState?.nextCursor ===
        "/services/data/v67.0/query/reconciliation-next" &&
      reconciliationCalls[1].cursor ===
        "/services/data/v67.0/query/reconciliation-next" &&
      reconciliationCalls[0].soql === reconciliationCalls[1].soql
  )
  ok(
    "reconciliation uses standard query and emits all records as upserts",
    reconciliationCalls.every((call) => !call.includeDeleted) &&
      firstReconciliationPage.changes[0].type === "upsert" &&
      finalReconciliationPage.changes[0].type === "upsert"
  )
  ok(
    "terminal reconciliation page has no continuation state",
    !finalReconciliationPage.hasMore &&
      !("nextState" in finalReconciliationPage)
  )
}

// ---------------------------------------------------------------------------
// Worker manifest
// ---------------------------------------------------------------------------

type SyncManifestConfig = {
  mode?: string
  schedule?: { type: string; intervalMs?: number }
}

function runManifestTests() {
  console.log("Worker manifest:")

  const syncCapabilities = worker.manifest.capabilities.filter(
    (capability) => capability._tag === "sync"
  )
  const syncConfig = (key: string): SyncManifestConfig | undefined =>
    syncCapabilities.find((capability) => capability.key === key)?.config as
      | SyncManifestConfig
      | undefined
  const incrementalConfigs = [
    syncConfig("accountsSync"),
    syncConfig("opportunitiesSync"),
  ]
  const reconciliationConfigs = [
    syncConfig("accountsReconciliation"),
    syncConfig("opportunitiesReconciliation"),
  ]

  ok(
    "accounts and opportunities increment every five minutes",
    incrementalConfigs.every(
      (config) =>
        config?.mode === "incremental" &&
        config.schedule?.type === "interval" &&
        config.schedule.intervalMs === 5 * 60_000
    )
  )
  ok(
    "accounts and opportunities reconcile with a daily replacement",
    reconciliationConfigs.every(
      (config) =>
        config?.mode === "replace" &&
        config.schedule?.type === "interval" &&
        config.schedule.intervalMs === 24 * 60 * 60_000
    )
  )

  ok(
    "headless client credentials do not register interactive OAuth",
    !worker.manifest.capabilities.some(
      (capability) => capability._tag === "oauth"
    )
  )
}

async function main() {
  runUrlConfigurationTests()
  runManifestTests()
  await runSessionProviderTests()
  await runApiClientTests()
  await runSyncLifecycleTests()

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
