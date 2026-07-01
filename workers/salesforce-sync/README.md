# Worker sync: Salesforce

Bring Salesforce account and pipeline context into Notion. One deploy creates
related **Salesforce Accounts** and **Salesforce Opportunities** databases, then
keeps them current with five-minute updates and daily reconciliation.

You do not need to create the Notion databases or provide a Notion API token.
Notion creates and manages both databases from the schemas in this Worker.

## Quickstart

You need Node.js 22+, a Salesforce production org or sandbox with API access,
and a local [External Client App](#create-the-salesforce-external-client-app)
configured for the client-credentials flow. Copy its consumer key and secret,
and note the org's My Domain URL.

From the repository root:

```sh
npm install --global ntn
cd workers/salesforce-sync
npm install
ntn login
ntn workers deploy --name salesforce-sync
ntn workers env set SALESFORCE_CLIENT_ID=your-consumer-key
ntn workers env set SALESFORCE_CLIENT_SECRET=your-consumer-secret
ntn workers env set SALESFORCE_ORG_URL=https://acme.my.salesforce.com
```

Use `--name salesforce-sync` only for the first deployment. After `workers.json`
identifies the deployed Worker, update it with `ntn workers deploy`.

Preview both databases without changing Notion, then start the real syncs:

```sh
ntn workers sync trigger accountsSync --preview
ntn workers sync trigger opportunitiesSync --preview
ntn workers sync trigger accountsSync
ntn workers sync trigger opportunitiesSync
```

The first run backfills every Account and Opportunity visible to the integration
user. After it completes, incremental updates run every five minutes and full
replacement sweeps run daily.

The selected fields and descriptions for every visible Account and Opportunity
are copied into Notion. Review both managed databases' sharing settings before
giving a broader audience access.

## What you can answer

| Managed database             | Questions it helps answer                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Salesforce Accounts**      | Which accounts are largest by revenue or headcount? How are accounts distributed by owner, industry, type, country, or recent changes? |
| **Salesforce Opportunities** | What is closing soon? How does pipeline break down by stage, owner, forecast category, lead source, probability, or account?           |

The Opportunity database relates each record to its Salesforce Account, so you
can move from an account to its open and historical opportunities in Notion.

## Reference

### Supported configuration

This example reads the standard Salesforce **Account** and **Opportunity**
objects from production orgs and sandboxes. Authentication uses the OAuth
client-credentials flow from a Salesforce External Client App with a dedicated
integration user as its **Run As** user.

The default mapping is intended for **single-currency orgs**. It stores `Amount`
and `AnnualRevenue` as numbers without `CurrencyIsoCode`; add that field before
using the Worker with a multi-currency org. Custom objects, custom fields, and
Person Account-specific fields are not included by default.

### Synced databases

| Managed database             | Salesforce object | Incremental updates | Full reconciliation |
| ---------------------------- | ----------------- | ------------------- | ------------------- |
| **Salesforce Accounts**      | Account           | Every 5 min         | Daily               |
| **Salesforce Opportunities** | Opportunity       | Every 5 min         | Daily               |

#### Salesforce Accounts

| Notion property | Salesforce field      | Type        |
| --------------- | --------------------- | ----------- |
| Name            | `Name`                | title       |
| Industry        | `Industry`            | select      |
| Type            | `Type`                | select      |
| Website         | `Website`             | url         |
| Phone           | `Phone`               | phoneNumber |
| Billing City    | `BillingCity`         | richText    |
| Billing Country | `BillingCountry`      | richText    |
| Annual Revenue  | `AnnualRevenue`       | number      |
| Employees       | `NumberOfEmployees`   | number      |
| Owner           | `Owner.Name`          | richText    |
| Created         | `CreatedDate`         | date        |
| Updated         | `LastModifiedDate`    | date        |
| Account Link    | Salesforce record URL | url         |
| Account ID      | `Id`                  | richText    |

Each Account page body contains its Salesforce `Description`. `Account ID` is
the stable sync key.

#### Salesforce Opportunities

| Notion property   | Salesforce field       | Type             |
| ----------------- | ---------------------- | ---------------- |
| Name              | `Name`                 | title            |
| Stage             | `StageName`            | select           |
| Amount            | `Amount`               | number           |
| Probability       | `Probability`          | number (percent) |
| Close Date        | `CloseDate`            | date             |
| Type              | `Type`                 | select           |
| Lead Source       | `LeadSource`           | select           |
| Forecast Category | `ForecastCategoryName` | select           |
| Is Closed         | `IsClosed`             | checkbox         |
| Is Won            | `IsWon`                | checkbox         |
| Owner             | `Owner.Name`           | richText         |
| Account           | `AccountId`            | relation         |
| Created           | `CreatedDate`          | date             |
| Updated           | `LastModifiedDate`     | date             |
| Opportunity Link  | Salesforce record URL  | url              |
| Opportunity ID    | `Id`                   | richText         |

Each Opportunity page body contains its Salesforce `Description`. Salesforce
percentages are converted to Notion's decimal percent format. **Account** is a
two-way relation keyed by `AccountId`; Notion adds the reciprocal
**Opportunities** property to each related Account.

### How it works

1. `accountsSync` and `opportunitiesSync` query Salesforce's `queryAll` REST
   resource every five minutes using a fixed `SystemModstamp` window.
2. A two-minute overlap makes boundary retries safe. Salesforce query locators
   page through up to 2,000 records per response.
3. Live records become Notion upserts; records marked `IsDeleted` become
   explicit deletes.
4. `accountsReconciliation` and `opportunitiesReconciliation` perform daily
   replacement sweeps. They remove pages for purged records, permission changes,
   and updates missed while the Worker was unavailable.
5. The client uses Salesforce REST API **v67.0**, caches one client-credentials
   access token, and renews it once after an HTTP 401.
6. All four syncs share a conservative request pacer. Salesforce limit responses
   are passed to the Workers runtime for retry and backoff.

#### Freshness and deletion behavior

The five-minute schedule is the normal update target, not a hard guarantee.
Throttling, an unavailable Worker, or a long initial backfill can increase
latency.

- A soft-deleted record returned by `queryAll` is normally removed after the
  next successful incremental run.
- A purged record, a newly hidden record, or a deletion missed during an outage
  is removed after the next successful daily reconciliation.
- A replacement sweep removes records the integration user can no longer see.

### Salesforce access and credentials

Use a dedicated integration user rather than a human administrator. Where
available, Salesforce recommends the Salesforce Integration user license with
the **Minimum Access - API Only Integrations** profile.

Grant only the access this read-only Worker needs, preferably through a
dedicated permission set:

- **API Enabled** system permission
- **Read** object permission on Account and Opportunity
- Read field-level access to every field in the property maps, including
  `Description`, `SystemModstamp`, `IsDeleted`, and `Owner.Name`
- **View All Records** on each object only when the Notion databases must
  represent every record in the org
- Access to the External Client App when its policy requires pre-authorization

Do not grant write access, **Modify All Records**, or **View All Data**. If the
sync should follow the integration user's Salesforce sharing rules, omit
**View All Records** and expect daily reconciliation to remove records that user
can no longer see.

#### Create the Salesforce External Client App

1. In Salesforce **Setup**, find **External Client App Manager** and select
   **New External Client App**.
2. Enter the app information and choose **Local** as its distribution state.
3. Under **API (Enable OAuth Settings)**, enable OAuth.
4. Enter `https://login.salesforce.com/services/oauth2/success` as the callback
   URL. The client-credentials flow does not use the redirect, but Salesforce
   requires a value.
5. Enable **Client Credentials Flow**. Leave **Authorization Code and
   Credentials Flow** disabled.
6. Add only **Manage user data via APIs** (`api`) as an OAuth scope.
7. Create the app. In **Policies**, enable client credentials and select the
   dedicated integration user as **Run As**.
8. Set **Permitted Users** to **Admin approved users are pre-authorized** and
   associate the integration user's permission set.
9. In **Settings**, open **Consumer Key and Secret** and copy both values.

New External Client Apps can take several minutes to become available. This
server-to-server flow has no interactive Salesforce sign-in and no refresh
token.

#### Environment variables

| Variable                   | Required | Description                                                                      |
| -------------------------- | -------- | -------------------------------------------------------------------------------- |
| `SALESFORCE_CLIENT_ID`     | Yes      | External Client App consumer key                                                 |
| `SALESFORCE_CLIENT_SECRET` | Yes      | External Client App consumer secret                                              |
| `SALESFORCE_ORG_URL`       | Yes      | Production or sandbox My Domain origin, such as `https://acme.my.salesforce.com` |

Use the specific org's My Domain URL, including for sandboxes—not
`login.salesforce.com` or `test.salesforce.com`. It must be an HTTPS origin with
no credentials, path, query string, or fragment.

### Project structure

```text
src/
├── index.ts         — registers the two databases and four syncs
├── salesforce.ts    — client credentials, REST requests, and pagination
├── sync.ts          — incremental and replacement sync lifecycle
├── accounts.ts      — Account fields, schema, and transform
└── opportunities.ts — Opportunity fields, schema, and transform
```

### Adapting the sync

Each resource module owns its field list, Salesforce type, managed-database
schema, and transform. To add a field:

1. Give the integration user read field-level access.
2. Add its API name to `ACCOUNT_FIELDS` or `OPPORTUNITY_FIELDS`.
3. Add it to the corresponding Salesforce TypeScript type.
4. Add the matching Notion property and transform value.

Salesforce returns only fields included in the SOQL `SELECT` list. Map nullable
values to an empty property value (`[]`) so clearing a field upstream also
clears its previous value in Notion.

To add an object, follow the Account and Opportunity modules, extend the
`SalesforceResource` object-name type in `src/sync.ts`, then register an
incremental sync and a replacement reconciliation in `src/index.ts`. Use the
same immutable Salesforce ID as the key for both.

### Local testing

Offline checks require no Salesforce connection:

```sh
npm run check
npm test
```

To run against the configured org, pull the deployed environment and execute a
sync locally:

```sh
ntn workers env pull
ntn workers exec accountsSync --local
ntn workers exec opportunitiesSync --local
```

Use a sandbox while changing schemas or queries.

### Troubleshooting

- **Authentication errors:** confirm that the key and secret came from the
  External Client App, client credentials is enabled in its policy, the Run As
  user is active, and `SALESFORCE_ORG_URL` is the exact My Domain origin.
- **`INVALID_FIELD` or insufficient access:** verify object and field-level read
  access for every field in `ACCOUNT_FIELDS` and `OPPORTUNITY_FIELDS`.
- **Missing records:** the Run As user's sharing rules define visibility unless
  **View All Records** is granted separately on both objects.
- **Empty Account relations:** sync Accounts first, and confirm each Opportunity
  has a readable `AccountId` matching an Account visible to the integration user.
- **Delayed runs:** Salesforce quotas vary by org. A throttled run completes only
  after the Workers runtime retries it.

### Learn more

- [Notion Workers documentation](https://developers.notion.com/workers/get-started/overview)
- [Salesforce External Client Apps](https://help.salesforce.com/s/articleView?id=sf.external_client_apps.htm&language=en_US&type=5)
- [Salesforce OAuth client credentials flow](https://help.salesforce.com/s/articleView?id=xcloud.remoteaccess_oauth_client_credentials_flow.htm&type=5)
- [Salesforce Integration user and client credentials](https://developer.salesforce.com/blogs/2024/02/invoke-rest-apis-with-the-salesforce-integration-user-and-oauth-client-credentials)
- [Salesforce REST API QueryAll](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_queryall.htm)
- [Contributing guide](../../CONTRIBUTING.md)
