# Worker sync: Salesforce

Syncs Salesforce Accounts and Opportunities into related Notion databases that
stay up to date automatically. The worker performs fast incremental updates
every 5 minutes and a complete daily reconciliation for each object.

You don't need to create the Notion databases yourself. The worker declares the
schemas and Notion creates and manages each database for you (these are called
"managed databases").

## Supported configuration

This example supports Salesforce production orgs and sandboxes with API access.
It reads the standard **Account** and **Opportunity** objects and the standard
fields listed below. Authentication uses the OAuth client-credentials flow from
a Salesforce **External Client App**, with a dedicated integration user as its
**Run As** user. New deployments should not create a legacy Connected App.

Custom objects, custom fields, Person Account-specific fields, and additional
standard objects are not included by default. You can add them by extending the
schemas, field lists, and sync registrations as described in
[Adapting the sync](#adapting-the-sync).

## What you get

| Database                     | Salesforce object | Incremental updates | Full reconciliation |
| ---------------------------- | ----------------- | ------------------- | ------------------- |
| **Salesforce Accounts**      | Account           | Every 5 min         | Daily               |
| **Salesforce Opportunities** | Opportunity       | Every 5 min         | Daily               |

### Salesforce Accounts

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

Each Account page body contains the Salesforce `Description` as markdown.
`SystemModstamp` drives incremental sync checkpoints, while `Account ID` is the
stable Notion sync key.

### Salesforce Opportunities

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

Each Opportunity page body contains the Salesforce `Description` as markdown.
Salesforce percentages are converted to Notion's decimal percent format.
`Amount` and `AnnualRevenue` are stored as plain numbers without a currency
symbol. Multi-currency orgs can add `CurrencyIsoCode` by following
[Adapting the sync](#adapting-the-sync).

**Account** is a two-way relation to the Salesforce Accounts database. The
relation uses `AccountId`, the same stable Salesforce ID used as the Account
sync key. Notion adds the reciprocal **Opportunities** property to each related
Account.

## Project structure

```text
src/
├── index.ts         — registers the databases and all four syncs
├── salesforce.ts    — client credentials, REST requests, and pagination
├── sync.ts          — incremental and replacement sync lifecycle
├── accounts.ts      — Account field list, schema, and transform
└── opportunities.ts — Opportunity field list, schema, and transform
```

## How it works

1. `accountsSync` and `opportunitiesSync` run every 5 minutes. Each one queries
   Salesforce's `queryAll` REST resource for a fixed `SystemModstamp` window,
   so current and soft-deleted records are returned together.
2. A two-minute overlap between completed windows makes boundary retries safe.
   Stable ordering, Salesforce query locators, and a batch-size hint of 2,000
   let each window continue across as many pages as necessary.
3. Live records become Notion `upsert` changes. Records marked `IsDeleted`
   become explicit Notion `delete` changes.
4. `accountsReconciliation` and `opportunitiesReconciliation` run daily in
   `replace` mode. They sweep every currently visible record and remove Notion
   pages that are absent after the complete sweep. This catches purged records,
   permission changes, and changes missed while the worker was unavailable.
5. All data requests use Salesforce REST API **v67.0**. The client exchanges
   the External Client App credentials for one cached access token. If
   Salesforce returns HTTP 401, it obtains a new token and retries once; the
   client-credentials flow does not use a refresh token.
6. The four syncs share a conservative request pacer. Salesforce API limits
   still depend on your org's edition and license count; limit responses are
   passed to the Workers runtime for retry and backoff.

### Freshness and deletion behavior

The 5-minute schedule is the normal update target, not a hard delivery
guarantee. API throttling, an unavailable worker, or a long initial backfill can
increase latency.

- A soft-deleted record still returned by `queryAll` is normally removed after
  the next successful incremental run: about 5 minutes plus execution time.
- A purged record, a record that becomes invisible to the integration user, or
  a deletion missed during an outage is removed after the next successful daily
  reconciliation: up to about 24 hours plus the time required to finish that
  sweep.
- Failed or rate-limited runs extend those windows until a run completes.

## Prerequisites

- Node >= 22 and npm >= 10.9.2
- A Salesforce production org or sandbox with REST API access
- Permission to create and manage a local External Client App
- A dedicated Salesforce integration user configured as the app's **Run As**
  user
- The `ntn` CLI installed and authenticated (`ntn login`)

### Configure least-privilege access

Use one dedicated integration user for this worker instead of running the sync
as a human administrator. Where available, Salesforce recommends the
Salesforce Integration user license with the **Minimum Access - API Only
Integrations** profile.

Grant that user only the access this read-only sync needs, preferably through a
dedicated permission set:

- **API Enabled** system permission
- **Read** object permission on Account and Opportunity
- Read field-level access to every field listed in the property maps, including
  `Description`, `SystemModstamp`, `IsDeleted`, and the Owner name used by each
  query
- **View All Records** on Account and Opportunity if the Notion databases must
  represent every record in the org
- Access to the External Client App, if its policy requires admin
  pre-authorization

`View All Records` is object-specific and does not bypass field-level security.
Grant it separately for both objects. Do not grant `Modify All Records`, `View
All Data`, or write permissions to this read-only worker.

You can omit `View All Records` when the sync is intentionally limited by the
integration user's Salesforce sharing rules. In that configuration, the daily
replacement sync treats records the user can no longer see as absent and
removes them from Notion.

## Environment variables

| Variable                   | Required | Description                                                                      |
| -------------------------- | -------- | -------------------------------------------------------------------------------- |
| `SALESFORCE_CLIENT_ID`     | Yes      | External Client App consumer key (`client_id`)                                   |
| `SALESFORCE_CLIENT_SECRET` | Yes      | External Client App consumer secret                                              |
| `SALESFORCE_ORG_URL`       | Yes      | Production or sandbox My Domain origin, such as `https://acme.my.salesforce.com` |

Use the specific org's My Domain URL, including for sandboxes—not the generic
`login.salesforce.com` or `test.salesforce.com` host. The value must be an HTTPS
origin without credentials, paths, query strings, or fragments.

No `NOTION_API_TOKEN` is needed. The platform handles Notion credentials
automatically.

## Setup and deploy

This server-to-server flow has no callback URL or interactive sign-in. The
External Client App runs every request as the dedicated integration user chosen
in its policy.

1. Install the Notion Workers CLI:

   ```sh
   curl -fsSL https://ntn.dev | bash
   ```

2. Clone and install:

   ```sh
   cd examples/workers/syncs/salesforce
   npm install
   ```

3. Typecheck and test:

   ```sh
   npm run check
   npm test
   ```

### Create the Salesforce External Client App

1. In Salesforce **Setup**, enter `External Client App` in Quick Find, open
   **External Client App Manager**, and select **New External Client App**.
2. Enter the basic app information. Select **Local** for the distribution state
   because this app is used by one Salesforce org.
3. Under **API (Enable OAuth Settings)**, enable OAuth.
4. Enter `https://login.salesforce.com/services/oauth2/success` as the
   **Callback URL**. Salesforce requires a value when OAuth is enabled, but the
   client-credentials flow never redirects to or calls this URL.
5. Under **Flow Enablement**, enable **Client Credentials Flow**. Leave
   **Authorization Code and Credentials Flow** disabled for this example.
6. Add only **Manage user data via APIs** (`api`) as an OAuth scope. Do not add
   `refresh_token` or `offline_access`; client credentials obtains a new access
   token instead of a refresh token.
7. Create the app. In its policies, configure **Client Credentials** and select
   the dedicated integration user as **Run As**.
8. Set **Permitted Users** to **Admin approved users are pre-authorized** and
   associate the dedicated permission set assigned to the integration user.
9. From the app's **Settings** tab, open **Consumer Key and Secret** and copy the
   consumer key and consumer secret.

This uses Salesforce's current External Client App framework, not a legacy
Connected App. A newly created app can take several minutes to become
available.

### Deploy and configure the worker

1. Log in to Notion:

   ```sh
   ntn login
   ```

2. Deploy the worker:

   ```sh
   ntn workers deploy --name salesforce-sync
   ```

   Use `--name` only when creating the worker. Later deployments update it with
   `ntn workers deploy`.

3. Store the External Client App credentials and your production or sandbox My
   Domain URL on the deployed worker:

   ```sh
   ntn workers env set SALESFORCE_CLIENT_ID=your-consumer-key
   ntn workers env set SALESFORCE_CLIENT_SECRET=your-consumer-secret
   ntn workers env set SALESFORCE_ORG_URL=https://acme.my.salesforce.com
   ```

   For a sandbox, use that sandbox's My Domain URL.

## Run the sync

Preview the incremental syncs without writing to Notion:

```sh
ntn workers sync trigger accountsSync --preview
ntn workers sync trigger opportunitiesSync --preview
```

Then start the real initial syncs:

```sh
ntn workers sync trigger accountsSync
ntn workers sync trigger opportunitiesSync
```

The first incremental run starts at the Unix epoch and can take longer than a
normal scheduled update. After it completes, both syncs run automatically every
5 minutes.

You can also preview or trigger the daily replacement reconciliations:

```sh
ntn workers sync trigger accountsReconciliation --preview
ntn workers sync trigger opportunitiesReconciliation --preview
ntn workers sync trigger accountsReconciliation
ntn workers sync trigger opportunitiesReconciliation
```

## Adapting the sync

Each resource owns its field list, TypeScript type, managed database schema, and
transform:

| Resource      | File                   |
| ------------- | ---------------------- |
| Accounts      | `src/accounts.ts`      |
| Opportunities | `src/opportunities.ts` |

To add a field:

1. Give the integration user read field-level access.
2. Add its API name to `ACCOUNT_FIELDS` or `OPPORTUNITY_FIELDS`.
3. Add the value to the corresponding Salesforce TypeScript type.
4. Add a Notion property to the resource schema.
5. Map the value in `accountToChange` or `opportunityToChange`.

Salesforce returns only fields included in the SOQL `SELECT` list. Adding a
type or Notion property without updating the field list does not fetch data.
Every upsert includes every declared Notion property. Map nullable Salesforce
values to an empty property value (`[]`) so clearing a field upstream also
clears its previous value in Notion.

To add a custom object, create a resource module following the Account and
Opportunity pattern, extend the `SalesforceResource` object-name type in
`src/sync.ts`, then register both an incremental and daily reconciliation sync
in `src/index.ts`. Keep the same stable Salesforce ID as the key for both syncs.

The REST API version is pinned in `src/salesforce.ts`. Review Salesforce release
notes and test production and sandbox orgs before changing `v67.0`.

## Local testing

Run offline tests without a Salesforce connection:

```sh
npm run check
npm test
```

To execute against the configured Salesforce org locally, pull the worker's
environment and run one sync:

```sh
ntn workers env pull
ntn workers exec accountsSync --local
ntn workers exec opportunitiesSync --local
```

Use a sandbox rather than production while testing schema or query changes.

## Troubleshooting

### `invalid_client`, `invalid_client_id`, or authentication fails

Confirm that the consumer key and secret came from **Consumer Key and Secret**
for the External Client App. Verify that **Client Credentials Flow** is enabled,
the dedicated integration user is selected as **Run As**, and
`SALESFORCE_ORG_URL` is that org's exact My Domain origin. New apps can take
several minutes to propagate.

The client caches the access token because Salesforce does not issue a refresh
token for this flow. An HTTP 401 clears the cached token and retries once. If
authentication still fails, verify that the Run As user remains active and has
access to the app's permission set.

### `INVALID_FIELD` or insufficient access

Verify that every field in `ACCOUNT_FIELDS` and `OPPORTUNITY_FIELDS` exists in
the org and is readable by the integration user. Confirm **API Enabled**, object
**Read**, and the required field-level permissions. Customizations can make a
field unavailable even when it is standard elsewhere.

### Records are missing or disappear after reconciliation

Salesforce REST queries use the **Run As** integration user's permissions and
sharing rules. Grant **View All Records** separately on Account and Opportunity
when the sync must cover the whole org. A completed daily replace sweep removes
records that are no longer visible to that user.

### Opportunity Account relations are empty

Confirm the Opportunity has an `AccountId`, that the integration user can read
the related Account, and that the initial Account sync completed. The relation
keys must match the Salesforce Account IDs synced into the Accounts database.

### API limits delay a run

Salesforce quotas vary by org. The client paces requests and reports limit
responses to the Workers runtime, but a throttled run still completes later.
Daily reconciliation removes absent pages only after every Salesforce page has
been processed successfully.

## Learn more

- [Notion Workers documentation](https://developers.notion.com/workers/get-started/overview)
- [Notion Workers secrets](https://developers.notion.com/workers/guides/secrets)
- [Salesforce External Client Apps](https://help.salesforce.com/s/articleView?id=sf.external_client_apps.htm&language=en_US&type=5)
- [Configure External Client App OAuth settings](https://help.salesforce.com/s/articleView?id=sf.configure_external_client_app_oauth_settings.htm&language=en_US&type=5)
- [Salesforce OAuth client credentials flow](https://help.salesforce.com/s/articleView?id=xcloud.remoteaccess_oauth_client_credentials_flow.htm&type=5)
- [Salesforce Integration user and client credentials](https://developer.salesforce.com/blogs/2024/02/invoke-rest-apis-with-the-salesforce-integration-user-and-oauth-client-credentials)
- [Salesforce OAuth scope values](https://developer.salesforce.com/docs/platform/mobile-sdk/guide/oauth-scope-parameter-values.html)
- [Give integration users API-only access](https://help.salesforce.com/s/articleView?id=User-Permission-for-API-Integration-User&language=en_US&type=1)
- [View All Records permission](https://help.salesforce.com/s/articleView?id=platform.users_profiles_view_all_mod_all.htm&language=en_US&type=5)
- [Salesforce REST API Query](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_query.htm)
- [Salesforce REST API QueryAll](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_queryall.htm)
- [Salesforce REST API limits](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_limits.htm)
- [Contributing guide](../../../../CONTRIBUTING.md)
